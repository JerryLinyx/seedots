// Orchestrates one candidate: detect type -> plan best tracks -> resumable download -> lossless finalise.
import fs from 'node:fs';
import path from 'node:path';
import { Http } from './http.mjs';
import { downloadDirect } from './direct.mjs';
import { planHls, downloadMediaPlaylist } from './hls.mjs';
import { parseMpd, planDash, downloadDashTrack } from './dash.mjs';
import { finalize } from './mux.mjs';
import { hash, sanitizeFilename, uniquePath, extOf } from './util.mjs';

const MIME_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/x-flv': 'flv', 'video/mp2t': 'ts', 'video/3gpp': '3gp',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'weba', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'text/vtt': 'vtt' };

export async function detectKind(http, url, headers) {
  const e = extOf(url);
  if (e === 'm3u8' || e === 'm3u') return 'hls';
  if (e === 'mpd') return 'dash';
  const info = await http.probe(url, { headers }).catch(() => null);
  if (info) {
    if (/mpegurl/.test(info.type)) return 'hls';
    if (/dash\+xml/.test(info.type)) return 'dash';
    if (/^(video|audio)\//.test(info.type) && !/mpegurl/.test(info.type)) return 'file';
    if (!info.size || info.size < 4 << 20) {
      const head = (await http.buffer(url, { range: [0, 2047], headers }).catch(() => Buffer.alloc(0))).toString('utf8').trimStart();
      if (head.startsWith('#EXTM3U')) return 'hls';
      if (/<MPD[\s>]/.test(head)) return 'dash';
    }
  }
  return 'file';
}

/**
 * cand: { kind, url?, inline?, base?, title?, headers?, cookies? }
 * opts: { outDir, quality, audioLang, subs, concurrency, retries, allowGaps, keepTemp, liveDuration, log, signal, filename }
 */
export async function downloadCandidate(cand, opts = {}) {
  const { outDir = 'downloads', log } = opts;
  if (cand.kind === 'site') { const { downloadSite } = await import('./ytdlp.mjs'); return downloadSite(cand, opts); }
  fs.mkdirSync(outDir, { recursive: true });
  const http = opts.http || new Http({ headers: cand.headers, cookies: cand.cookies, retries: opts.retries ?? 10, log });
  const kind = cand.kind && cand.kind !== 'unknown' ? cand.kind : await detectKind(http, cand.url);
  const name = sanitizeFilename(opts.filename || cand.title || (cand.url ? path.basename(new URL(cand.url).pathname).replace(/\.[^.]+$/, '') : 'media'));
  const tmpDir = path.join(outDir, '.mediagrab-tmp', hash((cand.url || '') + (cand.inline || '') + kind + (opts.quality || '')));
  fs.mkdirSync(tmpDir, { recursive: true });
  const common = { concurrency: opts.concurrency ?? 8, log, allowGaps: opts.allowGaps, signal: opts.signal };
  let result;

  if (kind === 'file') {
    const info = await http.probe(cand.url).catch(() => ({}));
    const dm = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(info.disposition || '');
    const ext = extOf(cand.url) || (dm && path.extname(decodeURIComponent(dm[1])).slice(1)) || MIME_EXT[info.type] || 'bin';
    const out = uniquePath(path.join(outDir, `${name}.${ext}`));
    const r = await downloadDirect(http, cand.url, out, { connections: Math.min(common.concurrency, 8), chunkSize: opts.chunkSize, log, label: name });
    result = { files: [r.path], warnings: [], info: { size: r.size } };
  } else if (kind === 'hls') {
    const src = { url: cand.url, inline: cand.inline, base: cand.base };
    const plan = await planHls(http, src, opts);
    const desc = plan.info.height ? `${plan.info.width}x${plan.info.height} @ ${(plan.info.bandwidth / 1000).toFixed(0)}kbps (best of ${plan.info.variants})` : 'single variant';
    log?.info(`HLS: ${desc}${plan.audio ? `, separate audio${plan.audio.language ? ' [' + plan.audio.language + ']' : ''}` : ''}`);
    const video = await downloadMediaPlaylist(http, plan.video, path.join(tmpDir, 'v'), { ...common, label: 'video', liveDuration: opts.liveDuration });
    const audio = plan.audio ? await downloadMediaPlaylist(http, plan.audio, path.join(tmpDir, 'a'), { ...common, label: 'audio', liveDuration: opts.liveDuration }) : null;
    const subs = [];
    for (const [i, s] of plan.subs.entries()) {
      try { const t = await downloadMediaPlaylist(http, s, path.join(tmpDir, 's' + i), { ...common, label: 'subs' }); subs.push({ parts: t.parts, container: 'vtt', language: s.language }); } catch (e) { log?.warn(`subtitles ${s.language}: ${e.message}`); }
    }
    result = await finalize({ video, audio, subs }, path.join(outDir, name), { tmpDir, log, expectedDuration: video.duration });
    const gaps = [...video.gaps, ...(audio?.gaps || [])];
    if (gaps.length) result.warnings.push(`${gaps.length} segment(s) could not be downloaded and were skipped`);
    result.info = { ...plan.info, segments: video.segments, refreshes: video.refreshes };
  } else if (kind === 'dash') {
    const text = cand.inline ?? await http.text(cand.url);
    const mpd = parseMpd(text, cand.base || cand.url);
    const t = planDash(mpd, opts);
    const v = t.video[0], a = t.audio[0];
    log?.info(`DASH: ${v ? `video ${v.width}x${v.height} ${v.codecs} ${(v.bandwidth / 1000).toFixed(0)}kbps` : 'no video'}${a ? `, audio ${a.codecs} ${(a.bandwidth / 1000).toFixed(0)}kbps${a.lang ? ' [' + a.lang + ']' : ''}` : ''}`);
    const video = t.video.length ? await downloadDashTrack(http, t.video, path.join(tmpDir, 'v'), { ...common, label: 'video' }) : null;
    const audio = t.audio.length ? await downloadDashTrack(http, t.audio, path.join(tmpDir, 'a'), { ...common, label: 'audio' }) : null;
    const subs = [];
    for (const [i, s] of t.subs.entries()) { try { const r = await downloadDashTrack(http, [s], path.join(tmpDir, 's' + i), { ...common, label: 'subs' }); subs.push({ parts: r.parts, container: r.container, language: s.lang }); } catch (e) { log?.warn(`subtitles: ${e.message}`); } }
    result = await finalize({ video: video || audio, audio: video ? audio : null, subs }, path.join(outDir, name), { tmpDir, log, expectedDuration: (video || audio).duration || mpd.duration });
    const gaps = [...(video?.gaps || []), ...(audio?.gaps || [])];
    if (gaps.length) result.warnings.push(`${gaps.length} segment(s) could not be downloaded and were skipped`);
    result.info = { width: v?.width, height: v?.height, bandwidth: v?.bandwidth };
  } else throw new Error(`unknown kind ${kind}`);

  if (!opts.keepTemp) fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(outDir, '.mediagrab-tmp')); } catch {}
  result.kind = kind; result.http = http.stats;
  return result;
}

/** Transfer streams resolved by yt-dlp with mediagrab's own engine (retries, resume, URL refresh), then remux losslessly. */
export async function downloadResolved(res, opts = {}) {
  const { outDir = 'downloads', log } = opts;
  const { pool } = await import('./util.mjs');
  if (res.formats.some(f => f.has_drm)) throw Object.assign(new Error('DRM-protected stream — not supported'), { drm: true });
  const name = sanitizeFilename(opts.filename || res.title || 'video');
  const tmpDir = path.join(outDir, '.mediagrab-tmp', hash('resolved' + res.formats.map(f => f.format_id).join('+') + name));
  fs.mkdirSync(tmpDir, { recursive: true });
  const tracks = {};
  for (const f of res.formats) {
    const http = new Http({ headers: f.headers, retries: opts.retries ?? 10, log });
    const dir = path.join(tmpDir, f.format_id.replace(/\W/g, '_'));
    let t;
    if (/m3u8/.test(f.protocol)) t = await downloadMediaPlaylist(http, { url: f.url }, dir, { concurrency: opts.concurrency ?? 8, log, label: f.kind, allowGaps: opts.allowGaps });
    else if (f.fragments) {
      fs.mkdirSync(dir, { recursive: true }); let done = 0, bytes = 0;
      await pool(f.fragments, opts.concurrency ?? 8, async (u, i) => {
        const fp = path.join(dir, String(i).padStart(6, '0'));
        if (!fs.existsSync(fp)) { const b = await http.buffer(u); fs.writeFileSync(fp + '.tmp', b); fs.renameSync(fp + '.tmp', fp); bytes += b.length; }
        log?.progress({ label: f.kind, done: ++done, total: f.fragments.length, bytes });
      });
      const part = path.join(dir, `part.${f.ext || 'mp4'}`); const fd = fs.openSync(part, 'w');
      f.fragments.forEach((_, i) => fs.writeSync(fd, fs.readFileSync(path.join(dir, String(i).padStart(6, '0'))))); fs.closeSync(fd);
      t = { parts: [part], container: f.ext || 'mp4' };
    } else {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `stream.${f.ext || 'bin'}`);
      if (!fs.existsSync(file)) await downloadDirect(http, f.url, file, { connections: Math.min(opts.concurrency ?? 8, 8), chunkSize: opts.chunkSize, log, label: f.kind });
      t = { parts: [file], container: f.ext || 'bin' };
    }
    if (tracks[f.kind]) tracks.audio = t; else tracks[f.kind] = t;
  }
  const video = tracks.video || tracks.audio, audio = tracks.video ? tracks.audio : null;
  const result = await finalize({ video, audio }, path.join(outDir, name), { tmpDir, log, expectedDuration: res.duration });
  if (!opts.keepTemp) fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(outDir, '.mediagrab-tmp')); } catch {}
  result.kind = 'site-hybrid';
  return result;
}
