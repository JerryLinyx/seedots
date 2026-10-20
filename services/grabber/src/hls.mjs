// HLS: playlist parsing, variant/rendition selection, resumable parallel segment download, AES-128 decryption, live capture.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool, sleep } from './util.mjs';
import { HttpError } from './http.mjs';

export function parseAttrs(s) {
  const out = {}; const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g; let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

const resolve = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };
function parseByteRange(s, prevEnd) { const [len, off] = String(s).split('@').map(Number); const o = Number.isFinite(off) ? off : prevEnd; return { start: o, end: o + len - 1 }; }

export function parseM3U8(text, base) {
  text = text.replace(/^﻿/, '');
  if (!/^\s*#EXTM3U/.test(text)) throw new Error('not an M3U8 playlist');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [], media = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18)); let j = i + 1; while (j < lines.length && lines[j].startsWith('#')) j++;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({ uri: resolve(lines[j], base), bandwidth: Number(a.BANDWIDTH) || 0, avgBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
          width: w || 0, height: h || 0, codecs: a.CODECS || '', frameRate: Number(a['FRAME-RATE']) || 0, audio: a.AUDIO, subtitles: a.SUBTITLES, video: a.VIDEO });
        i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({ type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE, default: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES', uri: a.URI ? resolve(a.URI, base) : null, channels: a.CHANNELS });
      }
    }
    return { type: 'master', variants, media };
  }
  const pl = { type: 'media', segments: [], endList: false, targetDuration: 0, mediaSequence: 0, playlistType: '' };
  let key = null, map = null, dur = 0, br = null, disc = false, seq = null, lastEnd = 0, lastUri = null, mapIdx = -1;
  const maps = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = Number(l.slice(22));
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.mediaSequence = Number(l.slice(22));
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) pl.playlistType = l.slice(21);
    else if (l === '#EXT-X-ENDLIST') pl.endList = true;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l.startsWith('#EXT-X-BYTERANGE:')) br = l.slice(17);
    else if (l === '#EXT-X-DISCONTINUITY') disc = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? resolve(a.URI, base) : null, iv: a.IV || null, keyformat: a.KEYFORMAT || 'identity' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = { uri: resolve(a.URI, base), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      maps.push(map); mapIdx = maps.length - 1;
    } else if (!l.startsWith('#')) {
      if (seq == null) seq = pl.mediaSequence;
      const uri = resolve(l, base);
      let range = null;
      if (br) { range = parseByteRange(br, uri === lastUri ? lastEnd + 1 : 0); lastEnd = range.end; }
      lastUri = uri;
      pl.segments.push({ uri, duration: dur, seq, key, map, mapIdx, range, discontinuity: disc });
      seq++; dur = 0; br = null; disc = false;
    }
  }
  pl.duration = pl.segments.reduce((a, s) => a + s.duration, 0);
  return pl;
}

export function isDrm(key) {
  if (!key) return false;
  if (key.method !== 'AES-128') return true; // SAMPLE-AES / SAMPLE-AES-CTR are DRM schemes (FairPlay/Widevine/PlayReady)
  return key.keyformat && key.keyformat !== 'identity';
}

export function pickVariant(variants, quality = 'best') {
  const score = v => (v.width * v.height) * 1e3 + (v.bandwidth || v.avgBandwidth) / 1e3;
  const sorted = [...variants].sort((a, b) => score(b) - score(a));
  if (quality === 'worst') return sorted[sorted.length - 1];
  const h = parseInt(quality, 10);
  if (Number.isFinite(h)) return sorted.find(v => v.height && v.height <= h) || sorted[sorted.length - 1];
  return sorted[0];
}

export function pickRendition(media, group, type, lang) {
  const c = media.filter(m => m.type === type && m.groupId === group && m.uri);
  if (!c.length) return null;
  return (lang && c.find(m => (m.language || '').toLowerCase().startsWith(lang.toLowerCase()))) || c.find(m => m.default) || c[0];
}

function ivFor(seg) {
  if (seg.key.iv) return Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
  const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(seg.seq), 8); return b;
}

function decrypt(data, key, iv) {
  try { const d = crypto.createDecipheriv('aes-128-cbc', key, iv); return Buffer.concat([d.update(data), d.final()]); }
  catch { const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false); return Buffer.concat([d.update(data), d.final()]); }
}

export function sniffContainer(buf) {
  if (!buf || buf.length < 4) return 'bin';
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
  if (buf.subarray(4, 8).toString('latin1').match(/ftyp|styp|moof|sidx|moov/)) return 'mp4';
  if (buf.subarray(0, 6).toString('latin1') === 'WEBVTT') return 'vtt';
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0)) return 'aac';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return 'bin';
}

/**
 * Download one media playlist into one or more concatenated part files.
 * Returns { parts: [file], container, duration, gaps }.
 */
export async function downloadMediaPlaylist(http, src, dir, opts = {}) {
  const { concurrency = 8, log, label = 'track', allowGaps = false, liveDuration = 0, signal, headers } = opts;
  fs.mkdirSync(dir, { recursive: true });
  const fetchPl = async () => {
    const text = src.inline != null && !src.refreshed ? src.inline : await http.text(src.url, { headers });
    const p = parseM3U8(text, src.base || src.url);
    if (p.type !== 'media') throw new Error('expected media playlist');
    return p;
  };
  let pl = await fetchPl();
  const drm = pl.segments.find(s => isDrm(s.key));
  if (drm) throw Object.assign(new Error(`DRM-protected stream (${drm.key.method}${drm.key.keyformat !== 'identity' ? ', ' + drm.key.keyformat : ''}) — not supported`), { drm: true });

  const live = !pl.endList && pl.playlistType !== 'VOD';
  const bySeq = new Map(); const order = [];
  const addSegs = p => { for (const s of p.segments) if (!bySeq.has(s.seq)) { bySeq.set(s.seq, s); order.push(s.seq); } };
  addSegs(pl);

  const keyCache = new Map();
  const getKey = async k => { if (!keyCache.has(k.uri)) keyCache.set(k.uri, (async () => { const b = await http.buffer(k.uri, { headers }); if (b.length !== 16) throw new Error(`bad AES key length ${b.length}`); return b; })()); return keyCache.get(k.uri); };
  const mapFiles = new Map();
  const getMap = async (m) => {
    const id = m.uri + (m.range ? `@${m.range.start}` : '');
    if (!mapFiles.has(id)) mapFiles.set(id, (async () => {
      const f = path.join(dir, `init_${mapFiles.size}.bin`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, await http.buffer(m.uri, { range: m.range ? [m.range.start, m.range.end] : undefined, headers }));
      return f;
    })());
    return mapFiles.get(id);
  };

  let refreshes = 0; const gaps = []; let doneCount = 0, bytes = 0;
  const segFile = s => path.join(dir, `seg_${String(s.seq).padStart(8, '0')}.bin`);
  async function fetchSeg(seq) {
    const f = segFile(bySeq.get(seq)); if (fs.existsSync(f)) { doneCount++; return; }
    for (let round = 0; ; round++) {
      const s = bySeq.get(seq);
      try {
        let data = await http.buffer(s.uri, { range: s.range ? [s.range.start, s.range.end] : undefined, headers });
        if (s.key) data = decrypt(data, await getKey(s.key), ivFor(s));
        if (s.map) await getMap(s.map);
        fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f);
        doneCount++; bytes += data.length; log?.progress({ label, done: doneCount, total: bySeq.size, bytes });
        return;
      } catch (e) {
        // Expired tokens / rotated URLs: re-fetch the playlist and retry the same sequence number with its fresh URI.
        if (round < 2 && !src.inline && (e instanceof HttpError || /truncated|timeout|fetch failed/.test(e.message))) {
          refreshes++; log?.debug(`refreshing playlist for seq ${seq}: ${e.message}`);
          try { const p = await fetchPl(); for (const ns of p.segments) if (bySeq.has(ns.seq)) bySeq.set(ns.seq, ns); } catch {}
          continue;
        }
        if (allowGaps) { gaps.push(seq); log?.warn(`segment ${seq} skipped: ${e.message}`); return; }
        throw e;
      }
    }
  }

  if (!live) {
    log?.info(`  ${label}: ${order.length} segments, ${pl.duration.toFixed(1)}s${pl.segments[0]?.key ? ', AES-128' : ''}`);
    await pool([...order], concurrency, fetchSeg);
  } else {
    const t0 = Date.now(); const limit = liveDuration > 0 ? liveDuration * 1000 : Infinity;
    log?.info(`  ${label}: live stream — recording ${liveDuration > 0 ? liveDuration + 's' : 'until the stream ends or Ctrl+C'}`);
    let next = 0; let ended = false;
    while (!ended && !signal?.aborted && Date.now() - t0 < limit) {
      const batch = order.slice(next); next = order.length;
      await pool(batch, concurrency, fetchSeg);
      await sleep(Math.max(1000, (pl.targetDuration || 4) * 500));
      try { pl = await fetchPl(); src.refreshed = true; addSegs(pl); ended = pl.endList; } catch (e) { log?.warn(`live refresh failed: ${e.message}`); }
    }
    await pool(order.slice(next), concurrency, fetchSeg);
  }

  // Assemble parts: split on discontinuities / init changes so timestamps and codec configs stay consistent.
  const segs = order.map(q => bySeq.get(q)).filter(s => fs.existsSync(segFile(s)));
  if (!segs.length) throw new Error('no segments downloaded');
  const first = fs.readFileSync(segFile(segs[0])).subarray(0, 400);
  const container = segs[0].map ? 'mp4' : sniffContainer(first);
  const parts = []; let cur = null, curMap = null;
  for (const s of segs) {
    if (!cur || s.discontinuity || s.mapIdx !== curMap) {
      if (cur) fs.closeSync(cur.fd);
      const file = path.join(dir, `part_${parts.length}.${container}`);
      cur = { fd: fs.openSync(file, 'w') }; parts.push(file); curMap = s.mapIdx;
      if (s.map) fs.writeSync(cur.fd, fs.readFileSync(await getMap(s.map)));
    }
    fs.writeSync(cur.fd, fs.readFileSync(segFile(s)));
  }
  if (cur) fs.closeSync(cur.fd);
  const duration = segs.reduce((a, s) => a + s.duration, 0);
  return { parts, container, duration, gaps, segments: segs.length, refreshes };
}

/** Resolve a candidate (master or media, URL or inline text) into the concrete tracks to fetch. */
export async function planHls(http, src, { quality = 'best', audioLang, subs = false, headers } = {}) {
  const text = src.inline ?? await http.text(src.url, { headers });
  const p = parseM3U8(text, src.base || src.url);
  if (p.type === 'media') return { video: { ...src, inline: src.inline }, audio: null, subs: [], info: { duration: p.duration } };
  if (!p.variants.length) throw new Error('master playlist has no variants');
  const v = pickVariant(p.variants, quality);
  const a = v.audio ? pickRendition(p.media, v.audio, 'AUDIO', audioLang) : null;
  const ss = subs && v.subtitles ? p.media.filter(m => m.type === 'SUBTITLES' && m.groupId === v.subtitles && m.uri) : [];
  return {
    video: { url: v.uri }, audio: a && a.uri !== v.uri ? { url: a.uri, language: a.language } : null,
    subs: ss.map(s => ({ url: s.uri, language: s.language || s.name })),
    info: { width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs, variants: p.variants.length },
  };
}
