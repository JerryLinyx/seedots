// Test server: static media with Range support, fault injection, Referer protection, opaque blob URLs, and test pages.
// Usage: node test/server.mjs [port]   env FLAKY=0.3 (probability of injected faults on media requests)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const FLAKY = Number(process.env.FLAKY || 0);
const stats = { requests: 0, faults: 0, media: 0 };
const SLOW = Number(process.env.SLOW || 0);
const T0 = Date.now();
function livePlaylist() { // sliding 3-segment window over v240 segments, one new segment every 2s, ENDLIST at the end
  const segs = fs.readFileSync(path.join(ROOT, 'hls_ts/v240.m3u8'), 'utf8').split('\n').filter(l => l.endsWith('.ts'));
  const head = Math.min(segs.length, 1 + Math.floor((Date.now() - T0) / 2000)); const start = Math.max(0, head - 3);
  const key = fs.readFileSync(path.join(ROOT, 'hls_ts/v240.m3u8'), 'utf8').match(/#EXT-X-KEY.*$/m)[0].replace('URI="k.key"', 'URI="/media/hls_ts/k.key"');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${start}`, key];
  for (let i = start; i < head; i++) lines.push('#EXTINF:2.0,', '/media/hls_ts/' + segs[i]);
  if (head >= segs.length) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.webm': 'video/webm',
  '.key': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.json': 'application/json',
};

// opaque ids for the MSE page: /blob/<id> -> mse/<file>
const mseFiles = fs.existsSync(path.join(ROOT, 'mse')) ? fs.readdirSync(path.join(ROOT, 'mse')).filter(f => f.endsWith('.webm')).sort() : [];
const blobIds = new Map(mseFiles.map((f, i) => [Buffer.from('x' + i + f).toString('hex').slice(0, 24), f]));
const idOf = f => [...blobIds].find(([, v]) => v === f)[0];

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

const PAGES = {
  'direct.html': () => page('Direct MP4 Test', `<video controls preload="metadata" src="/media/src/prog.mp4"></video>`),
  'audio.html': () => page('Audio Test', `<audio controls preload="auto" src="/media/audio/song.m4a"></audio>`),
  'hls.html': () => page('HLS AES Test', `<video id="v"></video><script>
    (async () => {
      const info = JSON.parse(await (await fetch('/api/hls.json')).text());
      const master = await (await fetch(info.stream.src)).text();
      const variant = new URL('v720.m3u8', new URL(info.stream.src, location.href)).href;
      const media = await (await fetch(variant)).text();
      await fetch(new URL('v720_000.ts', variant));
    })();</script>`),
  'fmp4.html': () => page('HLS fMP4 Separate Audio', `<script>
    (async () => { const u = '/media/' + ['hls', 'fmp4'].join('_') + '/master.m3u8'; await (await fetch(u)).text();
      await (await fetch('/media/hls_fmp4/aud.m3u8')).text(); })();</script>`),
  'dash.html': () => page('DASH Timeline Test', `<script>fetch('/media/dash/manifest.mpd').then(r => r.text()).then(() => fetch('/media/dash/init-stream0.m4s'));</script>`),
  'dashnum.html': () => page('DASH Number Test', `<script>fetch('/media/dash_num/manifest.mpd').then(r => r.text());</script>`),
  'iframe.html': () => page('Iframe Embed Test', `<iframe width="640" height="360" src="http://localhost:${PORT}/p/hls.html"></iframe>`),
  'jsonld.html': () => page('JSON-LD Video', `<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"demo","contentUrl":"/media/src/prog.mp4"}</script><p>video page</p>`),
  'noscript.html': () => page('Noscript Only', `<noscript><video controls><source src="/media/src/prog.mp4" type="video/mp4"></video></noscript><p>player loads with JS</p>`),
  'bot.html': () => page('Bot Protected HLS', `<script>fetch('/bot/hls_fmp4/master.m3u8').then(r => r.text());</script>`),
  'prot.html': () => page('Referer Protected HLS', `<script>fetch('/protected/hls_ts/master.m3u8').then(r => r.text());</script>`),
  'blobm3u8.html': () => page('Client Built Playlist', `<video id="v"></video><script>
    (async () => {
      const segs = await (await fetch('/api/segs.json')).json();
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-KEY:METHOD=AES-128,URI="' + segs.key + '",IV=' + segs.iv];
      for (const s of segs.list) { lines.push('#EXTINF:2.0,'); lines.push(s); }
      lines.push('#EXT-X-ENDLIST');
      const url = URL.createObjectURL(new Blob([lines.join('\\n')], { type: 'application/vnd.apple.mpegurl' }));
      document.getElementById('v').src = url;
    })();</script>`),
  'mse.html': () => page('MSE Opaque Segments', `<video id="v" muted playsinline></video><script>
    (async () => {
      const info = await (await fetch('/api/mse.json')).json(); // player-like retry loop below
      const v = document.getElementById('v'); const ms = new MediaSource(); v.src = URL.createObjectURL(ms);
      await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
      async function feed(mime, ids) {
        const sb = ms.addSourceBuffer(mime);
        for (const id of ids) {
          let buf; for (let t = 0; t < 30 && !buf; t++) { try { const r = await fetch('/blob/' + id); if (!r.ok) throw 0; buf = await r.arrayBuffer(); } catch (e) { await new Promise(r => setTimeout(r, 300)); } }
          await new Promise(r => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(buf); });
        }
      }
      await Promise.all([feed(info.vm, info.v), feed(info.am, info.a)]);
      ms.endOfStream();
    })();</script>`),
};

function api(name) {
  if (name === 'hls.json') return { stream: { src: `http://127.0.0.1:${PORT}/media/hls_ts/master.m3u8`, kind: 'hls' }, title: 'demo' };
  if (name === 'segs.json') {
    const pl = fs.readFileSync(path.join(ROOT, 'hls_ts/v720.m3u8'), 'utf8');
    const iv = pl.match(/IV=(0x[0-9a-f]+)/i)[1];
    return { key: `http://127.0.0.1:${PORT}/media/hls_ts/k.key`, iv, list: pl.split('\n').filter(l => l.endsWith('.ts')).map(l => `http://127.0.0.1:${PORT}/media/hls_ts/${l}`) };
  }
  if (name === 'mse.json') {
    const v = mseFiles.filter(f => /-0[-.]/.test(f)); const a = mseFiles.filter(f => /-1[-.]/.test(f));
    const order = l => [l.find(f => f.startsWith('init')), ...l.filter(f => f.startsWith('chunk'))];
    return { vm: 'video/webm; codecs="vp9"', am: 'audio/webm; codecs="opus"', v: order(v).map(idOf), a: order(a).map(idOf) };
  }
  return null;
}

function fault(req, res, size) {
  if (!FLAKY || Math.random() >= FLAKY) return null;
  stats.faults++;
  const r = Math.random();
  if (r < 0.35) { res.writeHead(500); res.end('injected'); return 'handled'; }
  if (r < 0.5) { res.writeHead(429, { 'Retry-After': '1' }); res.end('slow down'); return 'handled'; }
  if (r < 0.65) { res.writeHead(503); res.end(); return 'handled'; }
  if (r < 0.75) { setTimeout(() => req.socket.destroy(), 50); return 'handled'; } // connection reset, no response
  return 'truncate'; // send part of the body then reset
}

function sendFile(req, res, file, type) {
  let stat; try { stat = fs.statSync(file); } catch { res.writeHead(404); return res.end('nf'); }
  if (!stat.isFile()) { res.writeHead(404); return res.end('nf'); }
  const size = stat.size; let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  const f = fault(req, res, size); if (f === 'handled') return;
  const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  if (f === 'truncate') {
    let sent = 0; const cut = Math.floor((end - start + 1) / 2);
    stream.on('data', c => { if (sent + c.length > cut) { res.write(c.subarray(0, Math.max(0, cut - sent))); stream.destroy(); setTimeout(() => req.socket.destroy(), 20); } else { sent += c.length; res.write(c); } });
    return;
  }
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  stats.requests++;
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(u.pathname);
  if (p === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  if (p === '/live/live.m3u8') { res.writeHead(200, { 'Content-Type': TYPES['.m3u8'] }); return res.end(livePlaylist()); }
  if (p.startsWith('/media/') || p.startsWith('/blob/')) stats.media++;
  if (SLOW && p.startsWith('/media/') && !p.endsWith('.m3u8') && !p.endsWith('.mpd')) { setTimeout(() => route(req, res, u, p), SLOW); return; }
  route(req, res, u, p);
});
function route(req, res, u, p) {
  if (p.startsWith('/p/')) { const fn = PAGES[p.slice(3)]; if (!fn) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(fn()); }
  if (p.startsWith('/api/')) { const d = api(p.slice(5)); res.writeHead(d ? 200 : 404, { 'Content-Type': TYPES['.json'], 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify(d)); }
  if (p.startsWith('/blob/')) { const f = blobIds.get(p.slice(6)); if (!f) { res.writeHead(404); return res.end(); } return sendFile(req, res, path.join(ROOT, 'mse', f), 'application/octet-stream'); }
  let rel = null;
  if (p.startsWith('/media/')) rel = p.slice(7);
  if (p.startsWith('/protected/')) {
    const ref = req.headers.referer || '';
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/p\//.test(ref)) { res.writeHead(403); return res.end('referer required'); }
    rel = p.slice(11);
  }
  if (p.startsWith('/bot/')) { // simulated bot protection: only real browsers (client hints) get through
    if (!req.headers['sec-ch-ua']) { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<html>blocked</html>'); }
    rel = p.slice(5);
  }
  if (rel == null || rel.includes('..')) { res.writeHead(404); return res.end(); }
  const file = path.join(ROOT, rel);
  sendFile(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream');
}
server.listen(PORT, '127.0.0.1', () => console.log(`test server on http://127.0.0.1:${PORT} FLAKY=${FLAKY}`));
