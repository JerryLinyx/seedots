// MPEG-DASH: MPD parsing (SegmentTemplate/Timeline/Number, SegmentList, SegmentBase), best-track selection, segment download.
import fs from 'node:fs';
import path from 'node:path';
import { parseXml, kids, kid } from './xml.mjs';
import { pool } from './util.mjs';

export function parseDuration(s) {
  if (!s) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(x => (x ? parseFloat(x) : 0));
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + se;
}

const join = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };
const baseOf = (el, base) => { const b = kid(el, 'BaseURL'); return b && b.text.trim() ? join(b.text.trim(), base) : base; };
const range = s => { if (!s) return null; const [a, b] = s.split('-').map(Number); return { start: a, end: b }; };

function fill(tpl, rep, number, time) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|)(%0(\d+)d)?\$/g, (m, id, _f, width) => {
    if (id === '') return '$';
    const v = id === 'RepresentationID' ? rep.id : id === 'Number' ? number : id === 'Bandwidth' ? rep.bandwidth : time;
    return width ? String(v).padStart(Number(width), '0') : String(v);
  });
}

function mergeTemplate(...els) {
  const out = { attrs: {}, timeline: null };
  for (const e of els) if (e) { Object.assign(out.attrs, e.attrs); const tl = kid(e, 'SegmentTimeline'); if (tl) out.timeline = tl; }
  return out;
}

function segmentsFor(rep, ctx) {
  const { period, as, repEl, base, periodDuration } = ctx;
  const stEls = [kid(period, 'SegmentTemplate'), kid(as, 'SegmentTemplate'), kid(repEl, 'SegmentTemplate')];
  if (stEls.some(Boolean)) {
    const st = mergeTemplate(...stEls); const a = st.attrs;
    const timescale = Number(a.timescale || 1); const startNumber = Number(a.startNumber ?? 1);
    const out = { init: a.initialization ? { url: join(fill(a.initialization, rep, startNumber, 0), base) } : null, list: [] };
    if (st.timeline) {
      let t = 0, num = startNumber; const S = kids(st.timeline, 'S');
      const pto = Number(a.presentationTimeOffset || 0);
      const end = periodDuration != null ? pto + periodDuration * timescale : Infinity;
      S.forEach((s, i) => {
        if (s.attrs.t != null) t = Number(s.attrs.t);
        const d = Number(s.attrs.d); let r = Number(s.attrs.r || 0);
        if (r < 0) { const nt = S[i + 1]?.attrs.t != null ? Number(S[i + 1].attrs.t) : end; r = Math.ceil((nt - t) / d) - 1; }
        for (let k = 0; k <= r; k++) { out.list.push({ url: join(fill(a.media, rep, num, t), base), duration: d / timescale }); t += d; num++; }
      });
    } else if (a.duration) {
      const d = Number(a.duration) / timescale;
      const count = periodDuration ? Math.ceil(periodDuration / d - 1e-6) : 0;
      if (!count) throw new Error('cannot determine segment count (no duration in MPD)');
      for (let k = 0; k < count; k++) out.list.push({ url: join(fill(a.media, rep, startNumber + k, (startNumber + k - 1) * Number(a.duration)), base), duration: d });
      // segment counts derived from durations are often off by one: probe a few extra numbers at download time
      out.probeTail = k => join(fill(a.media, rep, startNumber + count + k, (startNumber + count + k - 1) * Number(a.duration)), base);
    } else if (a.media) { out.list.push({ url: join(fill(a.media, rep, startNumber, 0), base), duration: periodDuration || 0 }); }
    return out;
  }
  const sl = kid(repEl, 'SegmentList') || kid(as, 'SegmentList') || kid(period, 'SegmentList');
  if (sl) {
    const ini = kid(sl, 'Initialization'); const timescale = Number(sl.attrs.timescale || 1); const d = Number(sl.attrs.duration || 0) / timescale;
    return {
      init: ini ? { url: ini.attrs.sourceURL ? join(ini.attrs.sourceURL, base) : base, range: range(ini.attrs.range) } : null,
      list: kids(sl, 'SegmentURL').map(s => ({ url: s.attrs.media ? join(s.attrs.media, base) : base, range: range(s.attrs.mediaRange), duration: d })),
    };
  }
  // SegmentBase or bare BaseURL: one self-contained file
  return { single: { url: base }, list: [], init: null };
}

export function parseMpd(text, url) {
  const mpd = parseXml(text);
  if (mpd.name !== 'MPD') throw new Error('not a DASH MPD');
  const total = parseDuration(mpd.attrs.mediaPresentationDuration);
  const mbase = baseOf(mpd, url);
  const periods = kids(mpd, 'Period'); const out = { type: mpd.attrs.type || 'static', duration: total, periods: [] };
  let pStart = 0;
  periods.forEach((period, pi) => {
    const start = parseDuration(period.attrs.start) ?? pStart;
    const next = periods[pi + 1] ? parseDuration(periods[pi + 1].attrs.start) : null;
    const pdur = parseDuration(period.attrs.duration) ?? (next != null ? next - start : (total != null ? total - start : null));
    pStart = start + (pdur || 0);
    const pbase = baseOf(period, mbase); const P = { id: period.attrs.id, start, duration: pdur, adaptations: [] };
    for (const as of kids(period, 'AdaptationSet')) {
      const abase = baseOf(as, pbase);
      const asDrm = kids(as, 'ContentProtection').length > 0;
      const A = { contentType: as.attrs.contentType || '', mimeType: as.attrs.mimeType || '', lang: as.attrs.lang || '', reps: [] };
      for (const repEl of kids(as, 'Representation')) {
        const r = { id: repEl.attrs.id, bandwidth: Number(repEl.attrs.bandwidth || 0), width: Number(repEl.attrs.width || as.attrs.width || 0), height: Number(repEl.attrs.height || as.attrs.height || 0),
          codecs: repEl.attrs.codecs || as.attrs.codecs || '', mimeType: repEl.attrs.mimeType || A.mimeType, drm: asDrm || kids(repEl, 'ContentProtection').length > 0 };
        r.kind = kindOf(A, r);
        try { r.segments = segmentsFor(r, { period, as, repEl, base: baseOf(repEl, abase), periodDuration: pdur }); } catch (e) { r.error = e.message; }
        A.reps.push(r);
      }
      P.adaptations.push(A);
    }
    out.periods.push(P);
  });
  return out;
}

function kindOf(A, r) {
  const s = `${A.contentType} ${r.mimeType} ${A.mimeType}`.toLowerCase();
  if (/video/.test(s) || r.width) return 'video';
  if (/audio/.test(s)) return 'audio';
  if (/text|vtt|ttml|stpp|wvtt/.test(s) || /stpp|wvtt/.test(r.codecs)) return 'text';
  return 'other';
}

export function planDash(mpd, { quality = 'best', audioLang, subs = false } = {}) {
  if (mpd.type === 'dynamic') throw new Error('live DASH (type="dynamic") is not supported');
  const tracks = { video: [], audio: [], subs: [] }; let drm = false;
  for (const P of mpd.periods) {
    const reps = P.adaptations.flatMap(A => A.reps.map(r => ({ ...r, lang: A.lang })));
    const ok = reps.filter(r => !r.drm && !r.error);
    if (reps.some(r => r.drm) && !ok.some(r => r.kind === 'video' || r.kind === 'audio')) drm = true;
    const vids = ok.filter(r => r.kind === 'video').sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth);
    let v = vids[0];
    if (quality === 'worst') v = vids.at(-1); else if (Number.isFinite(parseInt(quality, 10))) v = vids.find(r => r.height <= parseInt(quality, 10)) || vids.at(-1);
    const auds = ok.filter(r => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);
    const a = (audioLang && auds.find(r => r.lang.toLowerCase().startsWith(audioLang.toLowerCase()))) || auds[0];
    if (v) tracks.video.push(v); if (a) tracks.audio.push(a);
    if (subs) for (const r of ok.filter(r => r.kind === 'text')) tracks.subs.push(r);
  }
  if (drm || (!tracks.video.length && !tracks.audio.length && mpd.periods.some(P => P.adaptations.some(A => A.reps.some(r => r.drm)))))
    throw Object.assign(new Error('DRM-protected DASH stream (ContentProtection) — not supported'), { drm: true });
  if (!tracks.video.length && !tracks.audio.length) throw new Error('no downloadable representations in MPD');
  return tracks;
}

/** Download the chosen representation(s) of one track (one per period) into part files. */
export async function downloadDashTrack(http, reps, dir, { concurrency = 8, log, label = 'track', headers, allowGaps = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const parts = []; let duration = 0; const gaps = [];
  for (const [pi, rep] of reps.entries()) {
    const S = rep.segments; const file = path.join(dir, `part_${pi}.${extFor(rep)}`);
    if (S.single) {
      const { downloadDirect } = await import('./direct.mjs');
      await downloadDirect(http, S.single.url, file, { connections: concurrency, headers, log, label });
      parts.push(file); continue;
    }
    const items = [...(S.init ? [{ ...S.init, init: true }] : []), ...S.list];
    log?.info(`  ${label}: ${rep.width ? rep.width + 'x' + rep.height + ' ' : ''}${rep.codecs} ${(rep.bandwidth / 1000).toFixed(0)}kbps, ${S.list.length} segments`);
    let done = 0, bytes = 0;
    await pool(items, concurrency, async (it, i) => {
      const f = path.join(dir, `p${pi}_${String(i).padStart(6, '0')}.bin`);
      if (!fs.existsSync(f)) {
        try {
          const data = await http.buffer(it.url, { range: it.range ? [it.range.start, it.range.end] : undefined, headers });
          fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); bytes += data.length;
        } catch (e) { if (allowGaps && !it.init) { gaps.push(i); log?.warn(`segment ${i} skipped: ${e.message}`); return; } throw e; }
      }
      log?.progress({ label, done: ++done, total: items.length, bytes });
    });
    if (S.probeTail) {
      for (let k = 0; k < 3; k++) {
        const data = await http.buffer(S.probeTail(k), { headers }).catch(e => { if (!(e.status >= 400 && e.status < 500)) log?.warn(`${label}: tail probe failed: ${e.message}`); return null; });
        if (!data || !data.length || data.subarray(0, 64).toString('latin1').toLowerCase().includes('<html')) break;
        const f = path.join(dir, `p${pi}_${String(items.length).padStart(6, '0')}.bin`); fs.writeFileSync(f, data);
        items.push({ url: S.probeTail(k) }); log?.debug(`${label}: found extra tail segment ${k + 1}`);
      }
    }
    const fd = fs.openSync(file, 'w');
    items.forEach((_, i) => { const f = path.join(dir, `p${pi}_${String(i).padStart(6, '0')}.bin`); if (fs.existsSync(f)) fs.writeSync(fd, fs.readFileSync(f)); });
    fs.closeSync(fd); parts.push(file);
    duration += S.list.reduce((a, s) => a + (s.duration || 0), 0);
  }
  return { parts, container: extFor(reps[0]), duration, gaps };
}

function extFor(rep) {
  const m = `${rep.mimeType} ${rep.codecs}`.toLowerCase();
  if (m.includes('webm') || /vp8|vp9|vorbis|opus/.test(m) && !m.includes('mp4')) return 'webm';
  if (m.includes('vtt')) return 'vtt';
  if (m.includes('ttml')) return 'ttml';
  return 'mp4';
}
