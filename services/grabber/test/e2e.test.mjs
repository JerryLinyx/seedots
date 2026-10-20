// End-to-end: runs the CLI against test pages on a flaky server and verifies outputs are lossless.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const FX = path.join(here, 'fixtures');
const CLI = path.join(here, '..', 'bin', 'mediagrab.mjs');
const PORT = 8795; const B = `http://127.0.0.1:${PORT}`; const flaky = process.env.FLAKY ?? '0.25';
const OUT = path.join(here, 'out-e2e'); fs.rmSync(OUT, { recursive: true, force: true });
// reference for the MSE page: concatenated init + chunks per track
const mse = d => [fs.readdirSync(path.join(FX, 'mse')).filter(f => f.startsWith(`init-${d}`)), fs.readdirSync(path.join(FX, 'mse')).filter(f => f.startsWith(`chunk-${d}-`)).sort()].flat();
for (const d of [0, 1]) fs.writeFileSync(path.join(FX, `mse_ref_${d}.webm`), Buffer.concat(mse(d).map(f => fs.readFileSync(path.join(FX, 'mse', f)))));

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), String(PORT)], { env: { ...process.env, FLAKY: flaky }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => srv.stdout.once('data', r));
const V = ['src/v720.mp4', 'v'], A = ['src/a.m4a', 'a'];
const cases = [
  ['direct.html', [V, A]], ['audio.html', [A]], ['hls.html', [V, A]], ['fmp4.html', [V, A]], ['dash.html', [V, A]], ['dashnum.html', [V, A]],
  ['iframe.html', [V, A]], ['prot.html', [V, A]], ['blobm3u8.html', [V, A]], ['bot.html', [V, A]],
  ['mse.html', [['mse_ref_0.webm', 'v'], ['mse_ref_1.webm', 'a']]],
  ['@direct-m3u8', [V, A], [`${B}/media/hls_ts/master.m3u8`, '-n', 'direct-m3u8']],
];
const run = args => new Promise(r => { const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('close', code => r({ code, out, err })); });
let fail = 0;
for (const [pg, refs, args] of cases) {
  const t0 = Date.now(); const dir = path.join(OUT, pg.replace(/\W/g, '_'));
  const r = await run([...(args || [`${B}/p/${pg}`]), '-o', dir, '--json', '--wait', '15', '--retries', '12']);
  let line;
  try {
    const j = JSON.parse(r.out); const res = j.results[0];
    if (!res || res.error) throw new Error(res?.error || 'no result');
    const checks = refs.map(([ref, sel]) => compare(res.files[0], path.join(FX, ref), sel));
    const bad = checks.find(c => !c.ok); if (bad) fail++;
    line = `${bad ? 'FAIL' : 'PASS'} ${pg.padEnd(15)} ${res.kind.padEnd(7)} ${path.basename(res.files[0]).padEnd(34)} ${checks.map(c => c.ok ? c.packets + (c.mode === 'packets' ? 'pk' : 'fr') : c.why).join(' ')}`;
    if (/retrying through the browser/.test(r.err)) line += ' [browser-fallback]';
  } catch (e) { fail++; line = `FAIL ${pg} ${e.message}\n${r.err.split('\n').slice(-15).join('\n')}`; }
  console.log(line + ` ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const st = await (await fetch(`${B}/stats`)).json();
console.log(`server: ${st.requests} requests, ${st.faults} injected faults (FLAKY=${flaky})`);
srv.kill(); process.exit(fail ? 1 : 0);
