// Local web UI (binds to 127.0.0.1 only): paste a link, see detected media, download, watch progress, open files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, fetchCandidate } from './engine.mjs';
import { captureMse } from './capture.mjs';
import { Logger } from './util.mjs';

const UI = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf8');
const MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', vtt: 'text/vtt', ts: 'video/mp2t' };

export async function serve({ port = 7788, outDir, log, defaults = {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const analyses = new Map(); const jobs = new Map(); let seq = 0;
  const sweep = () => { for (const [id, a] of analyses) if (Date.now() - a.t > 20 * 60000 && !a.busy) { a.r.session?.close().catch(() => {}); analyses.delete(id); } };
  setInterval(sweep, 60000).unref();

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

  function startJob(fn) {
    const job = { id: String(++seq), events: [], listeners: new Set(), done: false };
    const emit = e => { job.events.push(e); if (job.events.length > 500) job.events.splice(0, job.events.length - 500); for (const l of job.listeners) l(e); };
    jobs.set(job.id, job);
    const jl = new Logger({ quiet: true, onEvent: emit });
    fn(jl, emit).then(r => { job.done = true; emit({ type: 'done', files: (r.files || []).map(f => path.relative(outDir, f)), warnings: r.warnings || [] }); })
      .catch(e => { job.done = true; emit({ type: 'error', msg: e.message }); });
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(UI); }
      if (u.pathname === '/api/analyze' && req.method === 'POST') {
        const b = await body(req); if (!b.url) return json(res, 400, { error: '请先填写链接' });
        const job = startJob(async (jl, emit) => {
          const r = await analyze(b.url.trim(), { ...defaults, log: jl, wait: b.wait || defaults.wait || 25, headful: !!b.headful, profile: defaults.profile,
            onTraffic: t => emit({ ...t, mime: t.type, type: 'traffic' }), onCandidate: c => emit({ type: 'candidate', kind: c.kind }) });
          const id = String(++seq); analyses.set(id, { r, t: Date.now() });
          emit({ type: 'analysis', id, title: r.title, mseSeen: r.mseSeen, navError: r.navError || null, extractor: !!r.extractor, direct: !!r.direct, pageUrl: r.pageUrl,
            candidates: r.candidates.map(c => ({ id: c.id, kind: c.kind, url: c.url, inline: !!c.inline, via: c.via, size: c.size, type: c.type, summary: c.summary || null, error: c.error || null, note: c.note || null })) });
          return { files: [], warnings: [] };
        });
        return json(res, 200, { job: job.id });
      }
      if (u.pathname === '/api/download' && req.method === 'POST') {
        const b = await body(req); const a = analyses.get(String(b.analysis));
        if (!a) return json(res, 404, { error: 'analysis expired — analyze again' });
        a.busy = (a.busy || 0) + 1; a.t = Date.now();
        const opts = { ...defaults, outDir, quality: b.quality || 'best', subs: !!b.subs, audioLang: b.audioLang || undefined, allowGaps: !!b.allowGaps };
        const job = startJob(async jl => {
          try {
            if (b.candidate === 'capture') return await captureMse(a.r.pageUrl, { ...opts, log: jl, session: a.r.session });
            const c = a.r.candidates.find(x => x.id === Number(b.candidate)); if (!c) throw new Error('unknown candidate');
            return await fetchCandidate(c, a.r, { ...opts, log: jl });
          } finally { a.busy--; }
        });
        return json(res, 200, { job: job.id });
      }
      if (u.pathname.startsWith('/api/events/')) {
        const job = jobs.get(u.pathname.split('/').pop()); if (!job) return json(res, 404, {});
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
        job.events.forEach(send); job.listeners.add(send); req.on('close', () => job.listeners.delete(send)); return;
      }
      if (u.pathname === '/api/files') {
        const list = fs.readdirSync(outDir).filter(f => !f.startsWith('.') && !f.endsWith('.part') && !f.endsWith('.json')).map(f => { const s = fs.statSync(path.join(outDir, f)); return { name: f, size: s.size, mtime: s.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime);
        return json(res, 200, { dir: outDir, files: list });
      }
      if (u.pathname.startsWith('/files/')) {
        const name = decodeURIComponent(u.pathname.slice(7)); const f = path.join(outDir, name);
        if (!f.startsWith(outDir + path.sep) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        const size = fs.statSync(f).size; const type = MIME[path.extname(f).slice(1)] || 'application/octet-stream';
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        const dl = u.searchParams.has('dl') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {};
        if (m) { const s = m[1] ? Number(m[1]) : size - Number(m[2]); const e = m[1] && m[2] ? Number(m[2]) : size - 1;
          res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...dl }); return fs.createReadStream(f, { start: s, end: e }).pipe(res); }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', ...dl }); return fs.createReadStream(f).pipe(res);
      }
      res.writeHead(404); res.end();
    } catch (e) { log.warn(e.message); json(res, 500, { error: e.message }); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  log.info(`mediagrab UI → http://127.0.0.1:${port}   (files in ${outDir})`);
  return server;
}
