// Fallback transport: perform requests from inside the page (real browser TLS fingerprint, cookies, CORS context).
// Used when the direct Node HTTP client is rejected (401/403, bot protection) but the page itself can load the media.

export function browserTransport(page) {
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const h = {}; for (const [k, v] of Object.entries(headers)) if (/^(range|authorization|accept|x-[a-z0-9-]+)$/i.test(k)) h[k] = v;
    const r = await page.evaluate(async ({ url, method, h }) => {
      const res = await fetch(url, { method, headers: h, credentials: 'include', cache: 'no-store' });
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { status: res.status, url: res.url, headers: [...res.headers], b64: btoa(s) };
    }, { url, method, h });
    const body = Buffer.from(r.b64, 'base64');
    const hdrs = new Headers(r.headers.filter(([k]) => !/^(content-encoding|transfer-encoding)$/i.test(k)));
    hdrs.set('content-length', String(body.length));
    const res = new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: hdrs });
    Object.defineProperty(res, 'url', { value: r.url });
    return res;
  };
}
