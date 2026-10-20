// High-level API shared by the CLI and the web UI: analyze a URL, pick candidates, download with layered fallbacks.
import fs from 'node:fs';
import { sniff, launch, describe } from './sniff.mjs';
import { captureMse } from './capture.mjs';
import { downloadCandidate } from './download.mjs';
import { browserTransport } from './browserfetch.mjs';
import { Http, HttpError } from './http.mjs';
import { extOf } from './util.mjs';
import { findYtdlp, prefersExtractor, inspect, infoToCandidate } from './ytdlp.mjs';

const DIRECT_EXT = new Set(['m3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'm4a', 'mp3', 'aac', 'ogg', 'opus', 'flac', 'wav', 'ts']);

export function parseCookiesTxt(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const f = line.replace(/^#HttpOnly_/, '').split('\t'); if (f.length < 7) continue;
    out.push({ domain: f[0], path: f[2] || '/', secure: f[3] === 'TRUE', expires: Number(f[4]) || -1, name: f[5], value: f[6], httpOnly: line.startsWith('#HttpOnly_') });
  }
  return out;
}

export function parseHeaderArgs(list = []) {
  const h = {}; for (const s of list) { const i = s.indexOf(':'); if (i > 0) h[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim(); } return h;
}

export function isDirectUrl(url) { return DIRECT_EXT.has(extOf(url)); }

/** Detect media. Keeps the browser session open (returned) so downloads can fall back to in-browser fetching. */
export async function analyze(url, opts = {}) {
  const extraHeaders = opts.headers || {};
  const cookies = opts.cookiesFile ? parseCookiesTxt(opts.cookiesFile) : [];
  if (!opts.forceBrowser && (opts.noBrowser || isDirectUrl(url))) {
    return { title: opts.filename || null, pageUrl: url, direct: true, mseSeen: false,
      candidates: [{ id: 1, kind: 'unknown', url, via: ['direct'], headers: extraHeaders, cookies }] };
  }
  // 1) Dedicated extractor first for platforms where page sniffing is unreliable (YouTube & co.)
  const yt = opts.ytdlp === false ? null : findYtdlp(opts.ytdlp || undefined);
  if (yt && (opts.preferExtractor || prefersExtractor(url))) {
    try {
      opts.log?.info(`using yt-dlp ${yt.version} for ${new URL(url).hostname}`);
      const info = await inspect(url, { ...opts, yt, cookiesFile: opts.cookiesFile, headers: extraHeaders });
      const c = infoToCandidate(info, url);
      return { title: info.title, pageUrl: url, direct: false, mseSeen: false, extractor: true, candidates: [c] };
    } catch (e) {
      if (e.drm || e.code === 'playlist' || e.code === 'upcoming') throw e;
      opts.log?.warn(`yt-dlp could not handle it (${e.message}); falling back to page sniffing`);
    }
  } else if (!yt && prefersExtractor(url)) opts.log?.warn('this site works best with yt-dlp, which was not found (pip install -U "yt-dlp[default]")');
  // 2) Generic: open the page in a browser and watch the network
  const session = await launch(opts);
  if (cookies.length) await session.context.addCookies(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expires > 0 ? c.expires : -1 }))).catch(e => opts.log?.warn('cookies: ' + e.message));
  if (Object.keys(extraHeaders).length) await session.context.setExtraHTTPHeaders(extraHeaders);
  const r = await sniff(url, { ...opts, session });
  for (const c of r.candidates) c.headers = { ...c.headers, ...extraHeaders };
  // 3) Nothing usable on the wire: give yt-dlp's generic/site extractors a chance before MSE capture
  if (yt && !prefersExtractor(url) && !selectCandidates(r.candidates, 'best').length && !r.navError) {
    try {
      const info = await inspect(url, { ...opts, yt, headers: extraHeaders });
      const c = infoToCandidate(info, url); c.id = 0;
      r.candidates.unshift(c); r.candidates.forEach((x, i) => (x.id = i + 1));
      opts.log?.info(`yt-dlp found media via its ${c.summary.extractor} extractor`);
    } catch (e) { opts.log?.debug(`yt-dlp generic: ${e.message}`); }
  }
  return { ...r, session };
}

export function selectCandidates(candidates, pick) {
  const usable = candidates.filter(c => !c.error && !c.summary?.drm && c.kind !== 'subtitle');
  if (!pick || pick === 'best') return usable.slice(0, 1);
  if (pick === 'all') return usable;
  const ids = String(pick).split(',').map(s => Number(s.trim()));
  return candidates.filter(c => ids.includes(c.id));
}

/** Download one candidate with layered fallbacks: Node HTTP -> in-browser fetch -> MSE capture. */
export async function fetchCandidate(c, analysis, opts = {}) {
  const { log } = opts;
  if (c.kind === 'site') {
    const fatal = e => e.drm || ['access_required', 'playlist', 'upcoming', 'cancelled', 'unavailable', 'geo_blocked', 'unsupported_url', 'missing_dependency'].includes(e.code);
    try { return await downloadCandidate(c, { ...opts, filename: opts.filename }); }
    catch (e) {
      if (fatal(e)) throw e;
      log?.warn(`yt-dlp download failed (${e.message}); switching to hybrid transfer`);
      try {
        const { resolveFormats } = await import('./ytdlp.mjs'); const { downloadResolved } = await import('./download.mjs');
        const res = await resolveFormats(c.url, opts);
        return await downloadResolved({ ...res, title: c.title || res.title }, opts);
      } catch (e2) {
        if (e2.drm || fatal(e2) || !analysis.session || opts.capture === false) throw e2;
        log?.warn(`yt-dlp download failed (${e2.message}); falling back to MSE capture`);
        return await captureMse(analysis.pageUrl, { ...opts, session: analysis.session });
      }
    }
  }
  const attempt = (http) => downloadCandidate(c, { ...opts, http, filename: opts.filename });
  try {
    return await attempt(new Http({ headers: c.headers, cookies: c.cookies, retries: opts.retries ?? 10, log }));
  } catch (e) {
    if (e.drm) throw e;
    if (!analysis.session) throw e;
    log?.warn(`direct download failed (${e.message}); retrying through the browser`);
    const page = await analysis.session.context.newPage();
    try {
      await page.goto(c.frameUrl || analysis.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      return await attempt(new Http({ transport: browserTransport(page), retries: Math.min(opts.retries ?? 10, 6), log }));
    } catch (e2) {
      if (e2.drm) throw e2;
      if (opts.capture === false) throw e2;
      log?.warn(`in-browser download failed too (${e2.message}); falling back to MSE capture`);
      return await captureMse(analysis.pageUrl, { ...opts, session: analysis.session });
    } finally { await page.close().catch(() => {}); }
  }
}

export async function grab(url, opts = {}) {
  const { log } = opts;
  const analysis = await analyze(url, opts);
  try {
    const { candidates } = analysis;
    if (!analysis.direct) {
      log?.info(`\n${candidates.length} candidate(s) on "${analysis.title}":`);
      for (const c of candidates) log?.info(`  [${c.id}] ${describe(c)}\n      ${c.inline ? '(playlist built in page, via ' + c.via.join('+') + ')' : c.url}`);
    }
    if (opts.listOnly) return { analysis, results: [] };
    const results = [];
    if (opts.capture === true || (!selectCandidates(candidates, 'best').length && analysis.mseSeen && opts.capture !== false && analysis.session)) {
      if (!candidates.length) log?.info('no direct media URLs found, but the page uses MediaSource — switching to capture mode');
      results.push(await captureMse(analysis.pageUrl, { ...opts, session: analysis.session }));
      return { analysis, results };
    }
    const picks = selectCandidates(candidates, opts.pick);
    if (!picks.length) {
      const drm = candidates.find(c => c.summary?.drm);
      throw new Error(drm ? 'only DRM-protected streams were found — these cannot be downloaded' : 'no downloadable media found (try --headful to log in / start playback, --wait 60, or --capture)');
    }
    for (const c of picks) {
      log?.info(`\n↓ [${c.id}] ${describe(c)}`);
      try {
        const r = await fetchCandidate(c, analysis, { ...opts, filename: picks.length > 1 && opts.filename ? `${opts.filename} ${c.id}` : opts.filename });
        results.push({ id: c.id, ...r });
        for (const f of r.files) log?.info(`✔ ${f}`);
        for (const w of r.warnings) log?.warn(w);
      } catch (e) { results.push({ id: c.id, error: e.message }); log?.warn(`✘ [${c.id}] ${e.message}`); }
    }
    return { analysis, results };
  } finally { await analysis.session?.close().catch(() => {}); }
}

export { HttpError };
