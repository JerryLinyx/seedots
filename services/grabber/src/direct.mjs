// Direct (progressive) file download: parallel byte ranges, resumable across runs via a .part + .part.json state file.
import fs from 'node:fs';
import { pool, writeJsonAtomic } from './util.mjs';

export async function downloadDirect(http, url, outPath, { connections = 6, chunkSize, headers, log, label = 'file' } = {}) {
  const info = await http.probe(url, { headers });
  const part = outPath + '.part', stateFile = outPath + '.part.json';
  if (info.ranges && info.size) {
    chunkSize = chunkSize || 8 << 20; const size = info.size; const n = Math.ceil(size / chunkSize);
    let state = { size, done: [] };
    try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (s.size === size && fs.existsSync(part)) state = s; } catch {}
    const done = new Set(state.done);
    const fh = await fs.promises.open(part, fs.existsSync(part) ? 'r+' : 'w+');
    await fh.truncate(size);
    let bytes = [...done].reduce((a, i) => a + Math.min(chunkSize, size - i * chunkSize), 0);
    let lastSave = 0;
    const save = (force) => { if (force || Date.now() - lastSave > 1000) { lastSave = Date.now(); writeJsonAtomic(stateFile, { size, done: [...done] }); } };
    const todo = [...Array(n).keys()].filter(i => !done.has(i));
    log?.info(`  ${label}: ${n} chunk(s), ${todo.length} remaining, ${Math.min(connections, todo.length)} connection(s)`);
    try {
      await pool(todo, connections, async i => {
        const start = i * chunkSize, end = Math.min(size, start + chunkSize) - 1;
        await http.rangeToFile(url, fh, { start, end, headers, onBytes: b => { bytes += b; } });
        done.add(i); save(false);
        log?.progress({ label, done: done.size, total: n, bytes });
      });
    } finally { save(true); await fh.close(); }
    const st = fs.statSync(part);
    if (st.size !== size) throw new Error(`size mismatch ${st.size} != ${size}`);
  } else {
    // No range support: plain streaming download, restarted from scratch on failure (retries handled inside buffer()).
    const buf = await http.buffer(url, { headers });
    if (info.size && buf.length !== info.size) throw new Error(`size mismatch ${buf.length} != ${info.size}`);
    fs.writeFileSync(part, buf);
  }
  assertNotHtml(part);
  fs.renameSync(part, outPath); fs.rmSync(stateFile, { force: true });
  return { path: outPath, size: fs.statSync(outPath).size, type: info.type };
}

export function assertNotHtml(file) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(64); fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd);
  const s = b.toString('utf8').trimStart().toLowerCase();
  if (s.startsWith('<!doctype html') || s.startsWith('<html')) throw new Error('server returned an HTML page instead of media (login/anti-hotlink?)');
}
