// yt-dlp integration tests. Skipped when yt-dlp is not installed. Run: node test/ytdlp.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findYtdlp, prefersExtractor, classifyError, formatSelector, inspect, infoToCandidate, downloadSite } from '../src/ytdlp.mjs';
import { grab, fetchCandidate } from '../src/engine.mjs';
import { resolveFormats } from '../src/ytdlp.mjs';
import { downloadResolved } from '../src/download.mjs';
import { Logger } from '../src/util.mjs';
import { compare } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const FX = path.join(here, 'fixtures');
let fail = 0; const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!cond) fail++; };

// --- pure units ---
ok('prefers youtube', ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://m.youtube.com/shorts/x', 'https://www.bilibili.com/video/BV1'].every(prefersExtractor));
ok('generic sites not preferred', !prefersExtractor('https://example.com/video') && !prefersExtractor('https://notyoutube.com.evil.io/'));
ok('classify bot check', classifyError(["ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser"]).code === 'access_required');
ok('classify 429', classifyError(['ERROR: unable to download video data: HTTP Error 429: Too Many Requests']).code === 'rate_limited');
ok('classify drm', classifyError(['ERROR: [x] This video is DRM protected']).code === 'protected_media');
ok('classify unknown keeps detail', classifyError(['some line', 'ERROR: weird thing https://a.b/c']).message.includes('[链接]'));
ok('selector best', formatSelector({}) === 'bv*+ba/b/bv*');
ok('selector 1080 + lang', formatSelector({ quality: '1080', audioLang: 'ja' }).startsWith('bv*[height<=?1080]+ba[language^=ja]'));
ok('selector compat', formatSelector({ compat: true }).startsWith('bv*[vcodec^=avc1]+ba[ext=m4a]'));

const yt = findYtdlp();
if (!yt) { console.log('SKIP integration: yt-dlp not found (set MEDIAGRAB_YTDLP)'); process.exit(fail ? 1 : 0); }
console.log(`yt-dlp ${yt.version}`);
const PORT = 8798; const B = `http://127.0.0.1:${PORT}`; const flaky = process.env.FLAKY ?? '0.2';
const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), String(PORT)], { env: { ...process.env, FLAKY: flaky }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => srv.stdout.once('data', r));
const OUT = path.join(here, 'out-ytdlp'); fs.rmSync(OUT, { recursive: true, force: true });
const log = new Logger({ quiet: true, verbose: !!process.env.VERBOSE });
try {
  // 1) direct HLS (AES-128, TS) through yt-dlp's native HLS downloader, fragment progress, lossless
  const prog = []; const plog = new Logger({ quiet: true, onEvent: e => e.type === 'progress' && prog.push(e) });
  const info = await inspect(`${B}/media/hls_ts/master.m3u8`, {});
  const cand = infoToCandidate(info, `${B}/media/hls_ts/master.m3u8`);
  ok('inspect picks best height', cand.summary.height === 720, `heights=${cand.summary.heights}`);
  const r = await fetchCandidate({ ...cand, title: 'yt-hls' }, {}, { outDir: OUT, log: plog });
  const cv = compare(r.files[0], path.join(FX, 'src/v720.mp4'), 'v'), ca = compare(r.files[0], path.join(FX, 'src/a.m4a'), 'a');
  ok('AES HLS via engine (yt-dlp, hybrid if needed) lossless', cv.ok && ca.ok, `${path.basename(r.files[0])} via ${r.kind} ${cv.why || ''} ${ca.why || ''}`);
  // hybrid path directly: yt-dlp resolves, mediagrab transfers
  for (const [name, u] of [['hls_ts', `${B}/media/hls_ts/master.m3u8`], ['dash', `${B}/media/dash/manifest.mpd`]]) {
    const res = await resolveFormats(u, {});
    const rr = await downloadResolved({ ...res, title: 'hybrid-' + name }, { outDir: OUT, log });
    const a1 = compare(rr.files[0], path.join(FX, 'src/v720.mp4'), 'v'), a2 = compare(rr.files[0], path.join(FX, 'src/a.m4a'), 'a');
    ok(`hybrid ${name} lossless`, a1.ok && a2.ok, `${res.formats.map(f => f.format_id + ':' + f.protocol).join(' + ')} ${a1.why || ''} ${a2.why || ''}`);
  }
  // fragment-level progress (native HLS downloader; unencrypted fMP4 with separate audio)
  const prog2 = []; const plog2 = new Logger({ quiet: true, onEvent: e => e.type === 'progress' && prog2.push(e) });
  const r1b = await fetchCandidate({ kind: 'site', url: `${B}/media/hls_fmp4/master.m3u8`, title: 'yt-fmp4', summary: { duration: 16 } }, {}, { outDir: OUT, log: plog2 });
  const fv = compare(r1b.files[0], path.join(FX, 'src/v720.mp4'), 'v'), fa = compare(r1b.files[0], path.join(FX, 'src/a.m4a'), 'a');
  ok('yt-dlp fMP4 HLS + separate audio lossless', fv.ok && fa.ok);
  ok('fragment-level progress for video and audio', prog2.some(p => p.label === 'video' && p.total >= 8 && p.done === p.total) && prog2.some(p => p.label === 'audio' && p.total >= 9 && p.done === p.total),
    `video=${prog2.filter(p => p.label === 'video').length} audio=${prog2.filter(p => p.label === 'audio').length} events`);
  // 2) DASH separate audio/video merged without re-encoding
  const r2 = await fetchCandidate({ kind: 'site', url: `${B}/media/dash/manifest.mpd`, title: 'yt-dash', summary: {} }, {}, { outDir: OUT, log });
  const d1 = compare(r2.files[0], path.join(FX, 'src/v720.mp4'), 'v'), d2 = compare(r2.files[0], path.join(FX, 'src/a.m4a'), 'a');
  ok('yt-dlp DASH merge lossless', d1.ok && d2.ok, `${path.basename(r2.files[0])}`);
  // 3) error classification against a real failure
  let err; try { await inspect(`${B}/media/nope.mp4`, {}); } catch (e) { err = e; }
  ok('404 classified', err && ['unavailable', 'extractor_failed'].includes(err.code), err?.code + ' ' + err?.message);
  // 4) engine: page whose media is only inside <noscript> -> sniff finds nothing -> yt-dlp generic extractor
  const g = await grab(`${B}/p/noscript.html`, { outDir: OUT, log, wait: 8, idle: 2, minWait: 3, capture: false });
  const res = g.results[0];
  ok('engine falls back to yt-dlp', res && !res.error && res.kind === 'site', res?.error || res?.kind);
  if (res && !res.error) { const c = compare(res.files[0], path.join(FX, 'src/v720.mp4'), 'v'); ok('noscript download lossless', c.ok, path.basename(res.files[0])); }
  // 5) JSON-LD only page is now caught by the page sniffer itself
  const g2 = await grab(`${B}/p/jsonld.html`, { outDir: OUT, log, wait: 8, idle: 2, minWait: 3, listOnly: true });
  ok('json-ld detected by sniffer', g2.analysis.candidates.some(c => c.kind === 'file' && c.via.includes('json-ld')));
  // 6) --prefer-ytdlp on a page yt-dlp cannot parse falls back to sniffing
  const g3 = await grab(`${B}/p/fmp4.html`, { outDir: OUT, log, wait: 8, idle: 2, minWait: 3, listOnly: true, preferExtractor: true });
  ok('prefer-ytdlp falls back to sniffing', g3.analysis.candidates[0]?.kind === 'hls');
} catch (e) { fail++; console.log('FAIL', e.stack); }
const st = await (await fetch(`${B}/stats`)).json();
console.log(`server: ${st.requests} requests, ${st.faults} injected faults (FLAKY=${flaky})`);
srv.kill(); process.exit(fail ? 1 : 0);
