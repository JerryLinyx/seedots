// Core download tests (no browser) against the flaky test server. Run: node test/core.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadCandidate } from '../src/download.mjs';
import { Logger } from '../src/util.mjs';
import { compare } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures');
const PORT = 8790; const B = `http://127.0.0.1:${PORT}`;
const OUT = path.join(here, 'out-core'); fs.rmSync(OUT, { recursive: true, force: true });
const flaky = process.env.FLAKY ?? '0.3';
const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), String(PORT)], { env: { ...process.env, FLAKY: flaky }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => srv.stdout.once('data', r));
const log = new Logger({ quiet: true, verbose: !!process.env.VERBOSE });

const cases = [
  { name: 'hls-ts-aes', cand: { url: `${B}/media/hls_ts/master.m3u8` }, ref: [['src/v720.mp4', 'v'], ['src/a.m4a', 'a']] },
  { name: 'hls-fmp4-sep-audio', cand: { url: `${B}/media/hls_fmp4/master.m3u8` }, ref: [['src/v720.mp4', 'v'], ['src/a.m4a', 'a']] },
  { name: 'dash-timeline', cand: { url: `${B}/media/dash/manifest.mpd` }, ref: [['src/v720.mp4', 'v'], ['src/a.m4a', 'a']] },
  { name: 'dash-number', cand: { url: `${B}/media/dash_num/manifest.mpd` }, ref: [['src/v720.mp4', 'v'], ['src/a.m4a', 'a']] },
  { name: 'direct-mp4', cand: { url: `${B}/media/src/prog.mp4` }, ref: [['src/v720.mp4', 'v'], ['src/a.m4a', 'a']], opts: { concurrency: 6, chunkSize: 256 << 10 } },
  { name: 'quality-480', cand: { url: `${B}/media/hls_ts/master.m3u8` }, ref: [['src/v480.mp4', 'v']], opts: { quality: '480' } },
  { name: 'referer-required', cand: { url: `${B}/protected/hls_ts/master.m3u8`, headers: { referer: `${B}/p/prot.html` } }, ref: [['src/v720.mp4', 'v']] },
];

let fail = 0;
for (const c of cases) {
  const t0 = Date.now();
  try {
    const r = await downloadCandidate({ ...c.cand, title: c.name }, { outDir: OUT, log, retries: 12, ...(c.opts || {}) });
    const checks = c.ref.map(([ref, sel]) => compare(r.files[0], path.join(FX, ref), sel));
    const bad = checks.find(x => !x.ok);
    console.log(`${bad ? 'FAIL' : 'PASS'} ${c.name.padEnd(20)} ${path.basename(r.files[0])} ${checks.map(x => x.ok ? `${x.packets}${x.mode === 'packets' ? 'pk' : 'fr'}` : x.why).join(' ')} retries=${r.http.retries} ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.warnings.join('; ')}`);
    if (bad) fail++;
  } catch (e) { fail++; console.log(`FAIL ${c.name} ${e.stack}`); }
}
const stats = await (await fetch(`${B}/stats`)).json();
console.log(`server: ${stats.requests} requests, ${stats.faults} injected faults (FLAKY=${flaky})`);
srv.kill(); process.exit(fail ? 1 : 0);
