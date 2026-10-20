// Fault-tolerant HTTP client: retries with backoff, Retry-After, idle timeouts, truncation detection, range resume, cookie jar.
import { sleep } from './util.mjs';

export class HttpError extends Error {
  constructor(status, url, msg) { super(msg || `HTTP ${status} for ${url}`); this.status = status; this.url = url; }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const SOFT_STATUS = new Set([401, 403, 404, 410]); // retried a couple of times (CDN edge glitches), then fatal

export class CookieJar {
  constructor(cookies = []) { this.cookies = cookies; }
  header(url) {
    let u; try { u = new URL(url); } catch { return ''; }
    const now = Date.now() / 1000;
    return this.cookies.filter(c => {
      const d = (c.domain || '').replace(/^\./, '').toLowerCase();
      const host = u.hostname.toLowerCase();
      if (!(host === d || host.endsWith('.' + d))) return false;
      if (c.path && !u.pathname.startsWith(c.path)) return false;
      if (c.secure && u.protocol !== 'https:') return false;
      if (c.expires && c.expires > 0 && c.expires < now) return false;
      return true;
    }).map(c => `${c.name}=${c.value}`).join('; ');
  }
}

export class Http {
  constructor({ headers = {}, cookies = [], retries = 10, timeout = 30000, idleTimeout = 30000, log, transport } = {}) {
    this.transport = transport; this.base = lowerKeys(headers); this.jar = new CookieJar(cookies); this.retries = retries;
    this.timeout = timeout; this.idleTimeout = idleTimeout; this.log = log; this.stats = { retries: 0, requests: 0 };
  }

  headersFor(url, extra = {}) {
    const h = { 'accept': '*/*', 'accept-encoding': 'identity', ...this.base, ...lowerKeys(extra) };
    if (!h.cookie) { const c = this.jar.header(url); if (c) h.cookie = c; }
    for (const k of Object.keys(h)) if (h[k] == null || h[k] === '') delete h[k];
    delete h['host']; delete h['content-length']; delete h['range'];
    return h;
  }

  async backoff(attempt, res) {
    this.stats.retries++;
    let ms = Math.min(15000, 400 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    const ra = res?.headers?.get('retry-after');
    if (ra) { const s = Number(ra); ms = Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(ra) - Date.now()); ms = Math.min(ms, 60000); }
    await sleep(ms);
  }

  /** Low-level request with retries on connection errors and retryable statuses. Returns an open Response. */
  async request(url, { range, headers, method = 'GET', retries = this.retries } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const h = this.headersFor(url, headers);
      if (range) h.range = `bytes=${range[0]}-${range[1] ?? ''}`;
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error('connect timeout')), this.timeout);
      try {
        this.stats.requests++;
        const res = this.transport ? await this.transport(url, { method, headers: h, signal: ac.signal }) : await fetch(url, { method, headers: h, redirect: 'follow', signal: ac.signal });
        clearTimeout(t);
        res._ac = ac;
        if (res.ok) return res;
        await res.body?.cancel().catch(() => {});
        if (RETRY_STATUS.has(res.status) || (SOFT_STATUS.has(res.status) && attempt < 2)) {
          lastErr = new HttpError(res.status, url); this.log?.debug(`retry ${attempt + 1} ${res.status} ${short(url)}`);
          if (attempt < retries) { await this.backoff(attempt, res); continue; }
        }
        throw new HttpError(res.status, url);
      } catch (e) {
        clearTimeout(t);
        if (e instanceof HttpError && !RETRY_STATUS.has(e.status) && !(SOFT_STATUS.has(e.status) && attempt < 2)) throw e;
        lastErr = e; this.log?.debug(`retry ${attempt + 1} ${e.message} ${short(url)}`);
        if (attempt < retries) await this.backoff(attempt); else break;
      }
    }
    throw lastErr || new Error('request failed');
  }

  /** Read a body with an idle watchdog. Throws on stall. */
  async readBody(res, onChunk) {
    const reader = res.body.getReader(); let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => res._ac.abort(new Error('idle timeout')), this.idleTimeout); };
    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break; arm();
        if (await onChunk(value) === true) { reader.cancel().catch(() => {}); break; }
      }
    } finally { clearTimeout(timer); }
  }

  /**
   * Fetch a whole resource (or byte range) into memory, resuming after truncation.
   * range: [start, endInclusive] optional.
   */
  async buffer(url, { range, headers, retries = this.retries } = {}) {
    const chunks = []; let got = 0; let expected = null; let attempt = 0;
    const start = range ? range[0] : 0;
    for (;;) {
      let res;
      const want = (got > 0 || range) ? [start + got, range ? range[1] : undefined] : undefined;
      try {
        res = await this.request(url, { range: want, headers, retries });
        let skip = 0;
        if (want && res.status === 200) { // server ignored range: discard prefix
          skip = start; chunks.length = 0; got = 0;
        }
        const cl = Number(res.headers.get('content-length'));
        const encoded = res.headers.get('content-encoding') && res.headers.get('content-encoding') !== 'identity';
        if (expected == null) {
          if (range && range[1] != null) expected = range[1] - range[0] + 1;
          else if (res.status === 206) { const tot = totalFromContentRange(res.headers.get('content-range')); if (tot != null) expected = tot - start; }
          else if (cl && !encoded && !want) expected = cl;
        }
        let limit = expected;
        await this.readBody(res, c => {
          if (skip) { if (c.length <= skip) { skip -= c.length; return; } c = c.subarray(skip); skip = 0; }
          if (limit != null && got + c.length > limit) c = c.subarray(0, limit - got);
          if (c.length) { chunks.push(c); got += c.length; }
          return limit != null && got >= limit;
        }).catch(e => { if (!(limit != null && got >= limit)) throw e; });
        if (expected == null || got >= expected) return Buffer.concat(chunks, got);
        throw new Error(`truncated ${got}/${expected}`);
      } catch (e) {
        if (e instanceof HttpError && !RETRY_STATUS.has(e.status)) throw e;
        if (++attempt > retries) throw e;
        this.log?.debug(`resume ${short(url)} at ${got}: ${e.message}`);
        await this.backoff(Math.min(attempt, 5));
      }
    }
  }

  async text(url, opts) { return (await this.buffer(url, opts)).toString('utf8'); }

  /** Probe size / range support / content type with a 1-byte range request. */
  async probe(url, { headers } = {}) {
    const res = await this.request(url, { range: [0, 0], headers, retries: Math.min(this.retries, 4) });
    await res.body?.cancel().catch(() => {});
    const info = {
      finalUrl: res.url || url, status: res.status, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      disposition: res.headers.get('content-disposition') || '', size: null, ranges: false,
    };
    if (res.status === 206) { info.ranges = true; info.size = totalFromContentRange(res.headers.get('content-range')); }
    else { const cl = Number(res.headers.get('content-length')); if (cl) info.size = cl; }
    return info;
  }

  /** Stream a byte range into an open file handle at `fileOffset`, resuming after interruptions. */
  async rangeToFile(url, fh, { start, end, fileOffset = start, headers, onBytes, retries = this.retries }) {
    let got = 0; const total = end - start + 1; let attempt = 0;
    while (got < total) {
      try {
        const res = await this.request(url, { range: [start + got, end], headers, retries });
        if (res.status !== 206 && start + got > 0) { await res.body?.cancel().catch(() => {}); throw new HttpError(200, url, 'server stopped honouring Range'); }
        await this.readBody(res, async c => {
          const n = Math.min(c.length, total - got); if (n <= 0) return;
          await fh.write(c, 0, n, fileOffset + got); got += n; onBytes?.(n);
          return got >= total;
        }).catch(e => { if (got < total) throw e; });
        if (got < total) throw new Error(`truncated ${got}/${total}`);
      } catch (e) {
        if (e instanceof HttpError && !RETRY_STATUS.has(e.status)) throw e;
        if (++attempt > retries) throw e;
        await this.backoff(Math.min(attempt, 5));
      }
    }
    return got;
  }
}

export function totalFromContentRange(v) { const m = /\/(\d+)\s*$/.exec(v || ''); return m ? Number(m[1]) : null; }
function lowerKeys(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) r[k.toLowerCase()] = v; return r; }
const short = u => (u.length > 90 ? u.slice(0, 87) + '...' : u);
