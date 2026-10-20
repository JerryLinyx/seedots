// Injected into every frame (main world) before page scripts run. Reports media hints to Node via window.__mgReport.
// When window.__MG_CAPTURE is true, also mirrors every MSE appendBuffer() payload to Node via window.__mgChunk (lossless capture).
(() => {
  if (window.__mgInstalled) return; window.__mgInstalled = true;
  const report = (o) => { try { window.__mgReport && window.__mgReport({ ...o, page: location.href }); } catch (e) {} };
  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|f4v|m4a|mp3|aac|oga|ogg|opus|flac|wav|weba)(\?|#|$)/i;
  const seen = new Set();
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const native = (f, orig) => { try { Object.defineProperty(f, 'toString', { value: () => orig.toString(), configurable: true }); } catch (e) {} return f; };

  function scanString(s, via) {
    if (s.length < 7) return;
    const head = s.slice(0, 64).trimStart();
    if (head.startsWith('#EXTM3U')) { const k = 'i:' + s.length + s.slice(0, 200); if (!seen.has(k)) { seen.add(k); report({ type: 'inline', kind: 'hls', text: s, via }); } return; }
    if (s.length < 4e6 && /<MPD[\s>]/.test(s.slice(0, 2000))) { const k = 'd:' + s.length; if (!seen.has(k)) { seen.add(k); report({ type: 'inline', kind: 'dash', text: s, via }); } return; }
    if (s.length > 2048) return;
    if (/^(https?:)?\/\/|^\//.test(s) && MEDIA_RE.test(s)) { const u = abs(s.startsWith('//') ? location.protocol + s : s); if (u && !seen.has(u)) { seen.add(u); report({ type: 'url', url: u, via }); } }
  }
  function scan(o, depth, budget) {
    if (!o || depth > 12 || budget.n-- <= 0) return;
    if (typeof o === 'string') return scanString(o, 'json');
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) scan(v, depth + 1, budget); return; }
    for (const k in o) { try { scan(o[k], depth + 1, budget); } catch (e) {} }
  }

  // JSON.parse — player configs and API responses often carry stream URLs
  const jp = JSON.parse;
  JSON.parse = native(function (...a) { const r = jp.apply(this, a); try { scan(r, 0, { n: 5000 }); } catch (e) {} return r; }, jp);

  // Response.json() bypasses JSON.parse in some engines
  if (window.Response) {
    const rj = Response.prototype.json;
    Response.prototype.json = native(function () { return rj.call(this).then(r => { try { scan(r, 0, { n: 5000 }); } catch (e) {} return r; }); }, rj);
  }

  // Playlists built client-side and handed to <video> as blob: URLs
  const cou = URL.createObjectURL;
  URL.createObjectURL = native(function (obj) {
    const url = cou.call(this, obj);
    try {
      if (obj instanceof Blob && obj.size < 8e6 && /mpegurl|dash|text|xml|octet|^$/i.test(obj.type)) obj.slice(0, 8e6).text().then(t => scanString(t, 'blob')).catch(() => {});
      else if (window.MediaSource && obj instanceof MediaSource) report({ type: 'mse', blob: url });
    } catch (e) {}
    return url;
  }, cou);

  // src assignments on media elements
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...d, set(v) { try { if (v && !String(v).startsWith('blob:')) { const u = abs(v); if (u && !seen.has(u)) { seen.add(u); report({ type: 'url', url: u, via: 'media-src' }); } } } catch (e) {} return d.set.call(this, v); } });
  } catch (e) {}

  // MediaSource: note usage and optionally mirror appended bytes
  if (window.MediaSource) {
    const MS = window.MediaSource.prototype; let sbSeq = 0;
    const asb = MS.addSourceBuffer;
    MS.addSourceBuffer = native(function (mime) {
      const sb = asb.call(this, mime);
      try {
        const id = ++sbSeq + ':' + Math.random().toString(36).slice(2, 8); sb.__mgId = id; sb.__mgMime = mime; sb.__mgIdx = 0;
        report({ type: 'mse', mime });
        if (window.__MG_CAPTURE) {
          const ab = sb.appendBuffer;
          sb.appendBuffer = native(function (data) {
            try {
              const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const copy = new Uint8Array(u8); const idx = sb.__mgIdx++;
              const fr = new FileReader();
              fr.onload = () => { try { window.__mgChunk({ sb: id, mime, idx, data: String(fr.result).split(',')[1] || '', page: location.href }); } catch (e) {} };
              fr.readAsDataURL(new Blob([copy]));
            } catch (e) {}
            return ab.call(this, data);
          }, ab);
        }
      } catch (e) {}
      return sb;
    }, asb);
    const eos = MS.endOfStream;
    MS.endOfStream = native(function (...a) { try { report({ type: 'mse-end' }); } catch (e) {} return eos.apply(this, a); }, eos);
  }
})();
