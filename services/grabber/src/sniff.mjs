// Browser-based detection: loads the page in Chromium/Chrome, watches every network response in every frame,
// injects hooks (JSON.parse, blob playlists, media src, MSE), nudges players to start, then ranks candidates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseM3U8 } from './hls.mjs';
import { parseMpd } from './dash.mjs';
import { extOf, sleep } from './util.mjs';
import { Http } from './http.mjs';

const INJECT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'inject.js'), 'utf8');
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'f4v', '3gp', 'avi', 'wmv', 'ogv']);
const AUDIO_EXT = new Set(['m4a', 'mp3', 'aac', 'oga', 'ogg', 'opus', 'flac', 'wav', 'weba', 'wma']);
const SEG_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'm4v', 'm4a', 'aac', 'mp4', 'webm', 'vtt', 'key']);
const SUB_EXT = new Set(['vtt', 'srt', 'ass', 'ssa', 'ttml', 'dfxp']);
const KEEP_HEADERS = /^(referer|origin|user-agent|authorization|cookie|x-[a-z0-9-]+|accept-language)$/i;
const PLAY_SELECTORS = ['video', '.vjs-big-play-button', '.jw-display-icon-container', '.plyr__control--overlaid', '.ytp-large-play-button',
  'button[aria-label*="play" i]', '[class*="play-button" i]', '[class*="playButton" i]', '[class*="btn-play" i]', '.dplayer-mobile-play', '.prism-big-play-btn', '.xgplayer-start'];

export async function launch({ headful = false, profile, channel, log } = {}) {
  let pw; try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }
  const { chromium } = pw;
  const base = { headless: !headful, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'] };
  const ctxOpts = { ignoreHTTPSErrors: true, bypassCSP: true, viewport: { width: 1366, height: 820 }, locale: 'en-US' };
  const channels = channel === 'chromium-bundled' ? [undefined] : channel ? [channel] : ['chrome', 'msedge', undefined]; // real Chrome has H.264/AAC; bundled Chromium as last resort
  let lastErr;
  for (const ch of channels) {
    try {
      if (profile) { const ctx = await chromium.launchPersistentContext(profile, { ...base, ...ctxOpts, channel: ch }); return { context: ctx, close: () => ctx.close(), channel: ch || 'chromium' }; }
      const browser = await chromium.launch({ ...base, channel: ch });
      const ctx = await browser.newContext(ctxOpts);
      return { context: ctx, close: () => browser.close(), channel: ch || 'chromium' };
    } catch (e) { lastErr = e; log?.debug(`launch ${ch || 'chromium'} failed: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('could not launch a browser (install Google Chrome, or run `npx playwright install chromium`): ' + lastErr?.message);
}

function classify(url, ct, cd, rt) {
  const e = extOf(url); ct = (ct || '').toLowerCase();
  const dn = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd || ''); const de = dn ? (path.extname(decodeURIComponent(dn[1])).slice(1) || '').toLowerCase() : '';
  if (e === 'm3u8' || e === 'm3u' || /mpegurl/.test(ct)) return 'hls';
  if (e === 'mpd' || /dash\+xml/.test(ct)) return 'dash';
  if (SUB_EXT.has(e) || /text\/vtt|application\/x-subrip|ttml/.test(ct)) return 'subtitle';
  if (/^(video|audio)\//.test(ct) || VIDEO_EXT.has(e) || AUDIO_EXT.has(e) || VIDEO_EXT.has(de) || AUDIO_EXT.has(de) || rt === 'media') return 'file';
  if (e === 'ts' || /mp2t/.test(ct)) return 'file';
  return null;
}

const keyOf = u => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
const isAudio = c => /^audio\//.test(c.type || '') || AUDIO_EXT.has(extOf(c.url || ''));

/**
 * Detect media on a page. Returns { title, pageUrl, candidates, mseSeen, cookies, userAgent }.
 */
export async function sniff(pageUrl, opts = {}) {
  const { wait = 25, idle = 5, minWait = 6, log, onCandidate, onTraffic } = opts;
  const own = !opts.session; const session = opts.session || await launch(opts);
  const { context } = session;
  const found = new Map(); let lastNew = Date.now(); let mseSeen = false; const inlineBodies = new Map(); const pending = new Set();

  function add(c) {
    // YouTube's googlevideo URLs are ranged/SABR chunks, never a whole file: leave those to the extractor stage
    if (c.url && /(^|\.)googlevideo\.com$/i.test((() => { try { return new URL(c.url).hostname; } catch { return ''; } })())) return;
    const k = c.inline ? 'inline:' + c.inline.length + ':' + c.inline.slice(0, 300) : keyOf(c.url);
    const prev = found.get(k);
    if (prev) { prev.via = [...new Set([...prev.via, ...c.via])]; for (const f of ['size', 'type', 'status']) if (!prev[f] && c[f]) prev[f] = c[f]; if (c.headers && Object.keys(c.headers).length > Object.keys(prev.headers || {}).length) prev.headers = c.headers; return; }
    c.id = found.size + 1; found.set(k, c); lastNew = Date.now(); onCandidate?.(c);
    log?.debug(`found ${c.kind} ${c.inline ? '(inline)' : c.url}`);
  }

  const page = await context.newPage();
  await page.exposeBinding('__mgReport', (src, d) => {
    try {
      const frameUrl = src.frame?.url() || d.page;
      if (d.type === 'mse') { mseSeen = true; return; }
      if (d.type === 'url') { const kind = classify(d.url, '', '', ''); if (kind) add({ kind, url: d.url, via: [d.via], headers: { referer: frameUrl }, frameUrl }); }
      if (d.type === 'inline') add({ kind: d.kind, inline: d.text, base: frameUrl, via: [d.via], headers: { referer: frameUrl }, frameUrl });
    } catch {}
  });
  await page.addInitScript({ content: INJECT });

  const onResponse = async (res) => {
    const p = (async () => {
      const url = res.url(); if (!/^https?:/i.test(url)) return;
      const req = res.request(); const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'script', 'document', 'manifest', 'ping'].includes(rt) && !/\.(m3u8|mpd)(\?|$)/i.test(url)) return;
      const h = await res.allHeaders().catch(() => res.headers());
      const ct = (h['content-type'] || '').split(';')[0].trim();
      let kind = classify(url, ct, h['content-disposition'], rt);
      try { onTraffic?.({ url, kind: kind || (/(\.ts|\.m4s|\.m4f|\.cmf[va])(\?|$)/i.test(url) || /video|audio|octet/.test(ct) ? 'segment' : 'other'), status: res.status(), type: ct, size: Number(h['content-length'] || 0) || null }); } catch {}
      let body = null;
      if ((!kind || kind === 'hls' || kind === 'dash') && (rt === 'xhr' || rt === 'fetch' || rt === 'other' || kind) && res.status() < 300) {
        const cl = Number(h['content-length'] || 0);
        if (cl < 4e6 && !/^(image|font)\//.test(ct)) {
          body = await res.body().catch(() => null);
          const head = body ? body.subarray(0, 2000).toString('utf8').trimStart() : '';
          if (head.startsWith('#EXTM3U')) kind = 'hls'; else if (/<MPD[\s>]/.test(head)) kind = 'dash'; else if (kind === 'hls' || kind === 'dash') kind = null;
        }
      }
      if (!kind) return;
      const rh = await req.allHeaders().catch(() => req.headers());
      const headers = {}; for (const [k, v] of Object.entries(rh)) if (KEEP_HEADERS.test(k)) headers[k.toLowerCase()] = v;
      let frameUrl = null; try { frameUrl = req.frame().url(); } catch {}
      if (!headers.referer && frameUrl) headers.referer = frameUrl;
      let size = Number(h['content-length'] || 0) || null;
      const cr = /\/(\d+)$/.exec(h['content-range'] || ''); if (cr) size = Number(cr[1]);
      if (body && (kind === 'hls' || kind === 'dash')) inlineBodies.set(keyOf(url), body.toString('utf8'));
      add({ kind, url, type: ct, size, via: ['network'], headers, frameUrl, status: res.status(), ranged: !!h['content-range'] });
    })().catch(() => {});
    pending.add(p); p.finally(() => pending.delete(p));
  };
  context.on('response', onResponse);
  // URLs are learned at request time too, so a manifest whose request failed (reset, 5xx, blocked) is not lost
  const onRequest = (req) => {
    try {
      const url = req.url(); if (!/^https?:/i.test(url)) return;
      const kind = classify(url, '', '', req.resourceType() === 'media' ? 'media' : '');
      if (!kind) return;
      const headers = {}; for (const [k, v] of Object.entries(req.headers())) if (KEEP_HEADERS.test(k)) headers[k.toLowerCase()] = v;
      let frameUrl = null; try { frameUrl = req.frame().url(); } catch {}
      if (!headers.referer && frameUrl) headers.referer = frameUrl;
      add({ kind, url, via: ['request'], headers, frameUrl });
    } catch {}
  };
  context.on('request', onRequest);

  log?.info(`opening ${pageUrl} (${session.channel})`);
  let navError = null;
  try { const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); if (resp && resp.status() >= 400) navError = `HTTP ${resp.status()}`; }
  catch (e) { navError = e.message.split('\n')[0].replace(/^page\.goto: /, ''); log?.warn(`navigation: ${navError}`); }

  const t0 = Date.now(); let nudges = 0;
  while (Date.now() - t0 < wait * 1000) {
    if (nudges < 3 && Date.now() - t0 > [1500, 5000, 10000][nudges]) { nudges++; await nudgePlayback(page).catch(() => {}); }
    const quiet = Date.now() - lastNew > idle * 1000;
    if (Date.now() - t0 > minWait * 1000 && quiet && nudges >= 2) break;
    await sleep(400);
  }
  await collectDom(page, add).catch(() => {});
  await Promise.allSettled([...pending]);
  const title = (await page.title().catch(() => '')) || new URL(pageUrl).hostname;
  const cookies = await context.cookies().catch(() => []);
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
  context.off('response', onResponse); context.off('request', onRequest);

  // fetch manifests we only saw referenced (JSON/DOM) so they can be summarised and de-duplicated
  const http = new Http({ cookies, retries: 3, timeout: 15000, log });
  await Promise.all([...found.values()].filter(c => (c.kind === 'hls' || c.kind === 'dash') && !c.inline && !inlineBodies.has(keyOf(c.url))).map(async c => {
    // try Node first, then the page's own fetch (bot protection); a failure here never discards the candidate
    try { inlineBodies.set(keyOf(c.url), await http.text(c.url, { headers: { 'user-agent': userAgent, ...c.headers } })); }
    catch (e) {
      const t = await page.evaluate(u => fetch(u, { credentials: 'include' }).then(r => r.ok ? r.text() : null).catch(() => null), c.url).catch(() => null);
      if (t) inlineBodies.set(keyOf(c.url), t); else c.note = 'manifest not fetchable yet: ' + e.message;
    }
  }));
  if (own) await session.close().catch(() => {}); else await page.close().catch(() => {});
  const candidates = organize([...found.values()], inlineBodies, title);
  for (const c of candidates) { c.cookies = cookies; if (userAgent) c.headers = { 'user-agent': userAgent, ...c.headers }; }
  return { title, pageUrl, candidates, mseSeen, cookies, userAgent, navError };
}

async function nudgePlayback(page) {
  for (const f of page.frames()) {
    await f.evaluate(() => { for (const m of document.querySelectorAll('video,audio')) { try { m.muted = true; const p = m.play(); p && p.catch(() => {}); } catch (e) {} } }).catch(() => {});
  }
  for (const f of page.frames()) {
    for (const sel of PLAY_SELECTORS) {
      const loc = f.locator(sel).first();
      if (await loc.isVisible({ timeout: 200 }).catch(() => false)) { await loc.click({ timeout: 1500, force: sel === 'video' }).catch(() => {}); break; }
    }
  }
}

async function collectDom(page, add) {
  for (const f of page.frames()) {
    const items = await f.evaluate(() => {
      const out = []; const push = (u, how) => { if (u && !u.startsWith('blob:') && !u.startsWith('data:')) out.push([new URL(u, location.href).href, how]); };
      for (const m of document.querySelectorAll('video,audio')) { push(m.getAttribute('src'), 'dom'); push(m.currentSrc, 'dom'); for (const s of m.querySelectorAll('source[src],track[src]')) push(s.getAttribute('src'), 'dom'); }
      for (const m of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[property="og:audio"],meta[name="twitter:player:stream"]')) push(m.content, 'meta');
      const ld = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(ld); if (/VideoObject|AudioObject/.test(o['@type'])) { push(o.contentUrl, 'json-ld'); } for (const k in o) if (o[k] && typeof o[k] === 'object') ld(o[k]); };
      for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) { try { ld(JSON.parse(sc.textContent)); } catch (e) {} }
      for (const a of document.querySelectorAll('a[href]')) if (/\.(mp4|m4v|webm|mkv|mov|mp3|m4a|flac|wav|ogg|opus|m3u8|mpd)(\?|$)/i.test(a.getAttribute('href'))) push(a.getAttribute('href'), 'link');
      return { out, url: location.href };
    }).catch(() => null);
    if (!items) continue;
    for (const [u, how] of items.out) { const kind = classify(u, '', '', ''); if (kind) add({ kind, url: u, via: [how], headers: { referer: items.url }, frameUrl: items.url }); }
  }
}

/** Parse manifests, hide their children/segments, summarise, rank. */
function organize(list, bodies, title) {
  const childUrls = new Set(); const segUrls = new Set();
  for (const c of list) {
    const text = c.inline ?? bodies.get(keyOf(c.url));
    if (!text) continue;
    try {
      if (c.kind === 'hls') {
        const p = parseM3U8(text, c.base || c.url);
        if (p.type === 'master') {
          const best = [...p.variants].sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth)[0];
          c.summary = { master: true, variants: p.variants.length, width: best?.width, height: best?.height, bandwidth: best?.bandwidth, audioTracks: p.media.filter(m => m.type === 'AUDIO' && m.uri).length };
          for (const v of p.variants) childUrls.add(keyOf(v.uri)); for (const m of p.media) if (m.uri) childUrls.add(keyOf(m.uri));
        } else {
          c.summary = { duration: p.duration, segments: p.segments.length, live: !p.endList, encrypted: p.segments.some(s => s.key) ? p.segments.find(s => s.key).key.method : null };
          for (const s of p.segments) { segUrls.add(keyOf(s.uri)); if (s.map) segUrls.add(keyOf(s.map.uri)); if (s.key?.uri) segUrls.add(keyOf(s.key.uri)); }
        }
      } else if (c.kind === 'dash') {
        const m = parseMpd(text, c.base || c.url);
        const reps = m.periods.flatMap(P => P.adaptations.flatMap(A => A.reps));
        const v = reps.filter(r => r.kind === 'video').sort((a, b) => b.width * b.height - a.width * a.height)[0];
        c.summary = { duration: m.duration, width: v?.width, height: v?.height, bandwidth: v?.bandwidth, drm: reps.some(r => r.drm), live: m.type === 'dynamic' };
        for (const r of reps) { const S = r.segments; if (!S) continue; if (S.init) segUrls.add(keyOf(S.init.url)); for (const s of S.list) segUrls.add(keyOf(s.url)); }
      }
    } catch (e) { c.error = e.message; }
  }
  const hasManifest = list.some(c => c.kind === 'hls' || c.kind === 'dash');
  let out = list.filter(c => {
    const k = c.url && keyOf(c.url);
    if (k && childUrls.has(k)) return false;                       // variant/rendition of a master we already list
    if (k && segUrls.has(k)) return false;                         // segment of a listed manifest
    if (c.kind === 'file' && hasManifest) {                         // generic segment heuristics
      const e = extOf(c.url);
      if ((e === 'ts' || e === 'm4s' || e === 'cmfv' || e === 'cmfa' || /\b(seg|segment|chunk|frag|fragment)[-_]?\d+/i.test(c.url)) && (!c.size || c.size < 8 << 20)) return false;
    }
    if (c.kind === 'file' && extOf(c.url) === 'ts' && (c.size || 0) < 8 << 20) return false;
    return true;
  });
  // a media playlist whose segments belong to nothing else is still useful; masters first
  const score = c => {
    let s = 0;
    if (c.kind === 'hls' || c.kind === 'dash') s += 1e9 + (c.summary?.height || 0) * 1e5 + (c.summary?.master ? 5e4 : 0);
    else if (c.kind === 'file') s += (isAudio(c) ? 1e6 : 5e8) + Math.min(c.size || 0, 4e9) / 1e3;
    else s += 1;
    if (c.error || c.summary?.drm) s -= 2e9;
    return s;
  };
  out.sort((a, b) => score(b) - score(a));
  out.forEach((c, i) => { c.id = i + 1; c.title = title; });
  return out;
}

export function describe(c) {
  const s = c.summary || {}; const bits = [c.kind === 'site' ? `${s.extractor || 'site'} (yt-dlp)` : c.kind.toUpperCase()];
  if (c.kind === 'site' && s.heights?.length) bits.push(`${s.heights.length} heights up to ${s.heights[0]}p`);
  if (c.kind === 'site' && s.chapters) bits.push(`${s.chapters} chapters`);
  if (s.master) bits.push(`master ${s.variants} variants`);
  if (s.width) bits.push(`${s.width}x${s.height}`);
  if (s.bandwidth) bits.push(`${Math.round(s.bandwidth / 1000)}kbps`);
  if (s.duration) bits.push(`${s.duration.toFixed(0)}s`);
  if (s.audioTracks) bits.push(`${s.audioTracks} audio track(s)`);
  if (s.encrypted) bits.push(s.encrypted);
  if (s.live) bits.push('LIVE');
  if (s.drm) bits.push('DRM');
  if (c.size && c.kind === 'file') bits.push(`${(c.size / 1048576).toFixed(1)}MB`);
  if (c.type && c.kind === 'file') bits.push(c.type);
  if (c.error) bits.push('error: ' + c.error);
  return bits.join(' · ');
}
