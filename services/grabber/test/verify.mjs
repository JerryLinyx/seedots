// Lossless check: compares per-packet MD5 (stream copy, no decode) between output and reference for one stream type.
import { spawnSync } from 'node:child_process';

export function packetHashes(file, sel, decoded = false) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:${sel}:0`, ...(decoded ? [] : ['-c', 'copy']), '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`framemd5 failed for ${file}: ${r.stderr}`);
  return r.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => { const c = l.split(',').map(s => s.trim()); return decoded ? c[5] : `${c[4]}:${c[5]}`; });
}

function cmp(a, b, sel) {
  if (a.length !== b.length) return `${sel} count ${a.length} vs ref ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${sel} #${i} differs`;
  return null;
}

// 1) identical compressed packets (strongest)  2) else bit-identical decoded frames/samples (container repacking, e.g. TS Annex-B)
export function compare(out, ref, sel) {
  const a = packetHashes(out, sel), b = packetHashes(ref, sel);
  const why = cmp(a, b, sel);
  if (!why) return { ok: true, packets: a.length, mode: 'packets' };
  const da = packetHashes(out, sel, true), db = packetHashes(ref, sel, true);
  const why2 = cmp(da, db, sel);
  if (!why2) return { ok: true, packets: da.length, mode: 'decoded' };
  return { ok: false, why: `${why}; decoded: ${why2}` };
}
