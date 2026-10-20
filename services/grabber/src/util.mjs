import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Logger {
  constructor({ quiet = false, verbose = false, onEvent } = {}) { this.quiet = quiet; this.verbose = verbose; this.onEvent = onEvent; }
  info(...a) { if (!this.quiet) console.error(...a); this.onEvent?.({ type: 'log', level: 'info', msg: a.join(' ') }); }
  warn(...a) { console.error('⚠', ...a); this.onEvent?.({ type: 'log', level: 'warn', msg: a.join(' ') }); }
  debug(...a) { if (this.verbose) console.error('·', ...a); }
  progress(p) { this.onEvent?.({ type: 'progress', ...p }); if (this.quiet || !process.stderr.isTTY) return; const pct = p.total ? ((p.done / p.total) * 100).toFixed(1) : '?'; process.stderr.write(`\r  ${p.label || ''} ${pct}% (${p.done}/${p.total}) ${formatBytes(p.bytes || 0)}   `); if (p.done === p.total) process.stderr.write('\n'); }
}

export function formatBytes(n) {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

export function sanitizeFilename(s, max = 120) {
  const out = String(s || 'media').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (out || 'media').slice(0, max).trim();
}

export function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) { const c = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(c)) return c; }
}

export const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** Run tasks with bounded concurrency; stops scheduling new tasks after the first failure if failFast. */
export async function pool(items, concurrency, worker, { failFast = true } = {}) {
  let next = 0, failed = null; const results = new Array(items.length);
  async function run() {
    while (!(failFast && failed)) {
      const i = next++; if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); } catch (e) { if (failFast) { failed = failed || e; return; } results[i] = { error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  if (failed) throw failed;
  return results;
}

export function extOf(url) {
  try { const p = new URL(url).pathname; const m = /\.([a-z0-9]{1,5})$/i.exec(p); return m ? m[1].toLowerCase() : ''; } catch { return ''; }
}

export function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file);
}
