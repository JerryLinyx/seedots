// Last-resort lossless capture: mirrors every MediaSource appendBuffer() payload while the page plays (sped up),
// then rebuilds each SourceBuffer's byte stream and stream-copies them into one file. Works when stream URLs are
// opaque/obfuscated. Not for DRM (EME) content: encrypted payloads are useless without the CDM's keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './sniff.mjs';
import { finalize } from './mux.mjs';
import { hash, sanitizeFilename, sleep } from './util.mjs';

const INJECT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'inject.js'), 'utf8');

const isInit = (b, container) => container === 'webm'
  ? b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
  : b.length >= 8 && /^(ftyp|moov)$/.test(b.subarray(4, 8).toString('latin1'));

export async function captureMse(pageUrl, opts = {}) {
  const { outDir = 'downloads', log, rate = 16, maxDuration = 4 * 3600, idleTimeout = 45 } = opts;
  const own = !opts.session; const session = opts.session || await launch(opts);
  const tmp = path.join(outDir, '.mediagrab-tmp', 'cap-' + hash(pageUrl + Date.now()));
  fs.mkdirSync(tmp, { recursive: true });
  const bufs = new Map(); let lastChunk = Date.now(); let ended = false; let bytes = 0; let writes = 0;

  const page = await session.context.newPage();
  await page.exposeBinding('__mgChunk', (src, d) => {
    let sb = bufs.get(d.sb);
    if (!sb) { sb = { mime: d.mime, dir: path.join(tmp, 'sb' + bufs.size), count: 0 }; fs.mkdirSync(sb.dir, { recursive: true }); bufs.set(d.sb, sb); log?.info(`  capturing SourceBuffer ${d.mime}`); }
    const b = Buffer.from(d.data, 'base64'); fs.writeFileSync(path.join(sb.dir, String(d.idx).padStart(8, '0')), b);
    sb.count++; bytes += b.length; writes++; lastChunk = Date.now(); log?.progress({ label: 'capture', done: writes, total: 0, bytes });
    if (writes % 20 === 0) log?.info(`  captured ${(bytes / 1048576).toFixed(1)}MB in ${writes} appends`);
  });
  await page.exposeBinding('__mgReport', (src, d) => { if (d.type === 'mse-end') { ended = true; log?.debug('endOfStream()'); } });
  await page.addInitScript({ content: 'window.__MG_CAPTURE = true;\n' + INJECT });
  log?.info(`capture mode: playing ${pageUrl} at up to ${rate}x and recording MSE buffers`);
  try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { log?.warn(`navigation: ${e.message.split('\n')[0]}`); }

  const t0 = Date.now(); let title = '';
  while (Date.now() - t0 < maxDuration * 1000) {
    let state = { playing: false, ended: false, any: false, t: 0, d: 0 };
    for (const f of page.frames()) {
      const s = await f.evaluate(r => {
        const out = { playing: false, ended: false, any: false, t: 0, d: 0 };
        for (const v of document.querySelectorAll('video,audio')) {
          out.any = true; try { v.muted = true; if (v.playbackRate !== r) { try { v.playbackRate = r; } catch (e) { v.playbackRate = 4; } } if (v.paused && !v.ended) v.play().catch(() => {}); } catch (e) {}
          if (!v.paused) out.playing = true; if (v.ended) out.ended = true; if (v.duration && isFinite(v.duration)) { out.t = v.currentTime; out.d = v.duration; }
        }
        return out;
      }, rate).catch(() => null);
      if (s) { state = { playing: state.playing || s.playing, ended: state.ended || s.ended, any: state.any || s.any, t: Math.max(state.t, s.t), d: Math.max(state.d, s.d) }; }
    }
    if (!title) title = await page.title().catch(() => '');
    if ((ended || state.ended) && Date.now() - lastChunk > 1500) break;
    if (bufs.size && Date.now() - lastChunk > idleTimeout * 1000) { log?.warn('no new media data for a while — stopping capture'); break; }
    if (!bufs.size && Date.now() - t0 > 60000) break;
    await sleep(700);
  }
  await sleep(500);
  if (own) await session.close().catch(() => {}); else await page.close().catch(() => {});
  if (!bufs.size) throw new Error('capture: the page never fed a MediaSource (nothing to record)');

  // Rebuild tracks: order by append index, drop repeated identical init segments, split on changed inits.
  const tracks = {};
  for (const sb of bufs.values()) {
    const kind = /^audio\//.test(sb.mime) ? 'audio' : 'video';
    const container = /webm/.test(sb.mime) ? 'webm' : /mp2t/.test(sb.mime) ? 'ts' : 'mp4';
    const files = fs.readdirSync(sb.dir).sort();
    const parts = []; let fd = null; let lastInit = null;
    for (const f of files) {
      const b = fs.readFileSync(path.join(sb.dir, f));
      if (isInit(b, container)) {
        if (lastInit && b.equals(lastInit)) continue;
        if (fd !== null) fs.closeSync(fd);
        const p = path.join(sb.dir, `part_${parts.length}.${container}`); parts.push(p); fd = fs.openSync(p, 'w'); lastInit = b;
      } else if (fd === null) { const p = path.join(sb.dir, `part_${parts.length}.${container}`); parts.push(p); fd = fs.openSync(p, 'w'); }
      fs.writeSync(fd, b);
    }
    if (fd !== null) fs.closeSync(fd);
    if (parts.length > 1) log?.warn(`${kind}: stream changed format ${parts.length - 1} time(s) during capture (adaptive bitrate switch?)`);
    if (!tracks[kind] || fs.statSync(parts[0]).size > fs.statSync(tracks[kind].parts[0]).size) tracks[kind] = { parts, container };
  }
  const name = sanitizeFilename(opts.filename || title || new URL(pageUrl).hostname);
  const r = await finalize({ video: tracks.video || tracks.audio, audio: tracks.video ? tracks.audio : null }, path.join(outDir, name), { tmpDir: tmp, log });
  const { probe } = await import('./mux.mjs');
  const pr = r.files[0] && await probe(r.files[0]);
  if (r.files[0] && pr === null && (await import('./mux.mjs')).hasFfmpeg()) throw new Error('captured data is not a valid media stream (player fed corrupt or encrypted data)');
  if (!opts.keepTemp) fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(outDir, '.mediagrab-tmp')); } catch {}
  r.kind = 'capture'; r.info = { bytes, appends: writes };
  return r;
}
