// Lossless finalisation: stream-copy remux with ffmpeg (never re-encodes), container fallback chain, integrity checks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { uniquePath } from './util.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
let _has;
export function hasFfmpeg() { if (_has === undefined) _has = spawnSync(FFMPEG, ['-version']).status === 0 && spawnSync(FFPROBE, ['-version']).status === 0; return _has; }

function run(bin, args) {
  return new Promise((res) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('close', code => res({ code, out, err })); p.on('error', e => res({ code: -1, out, err: String(e) }));
  });
}

export async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

const WEBM_OK = new Set(['vp8', 'vp9', 'av1', 'opus', 'vorbis']);
const AUDIO_EXT = { aac: 'm4a', alac: 'm4a', mp3: 'mp3', opus: 'opus', vorbis: 'ogg', flac: 'flac', ac3: 'ac3', eac3: 'eac3', pcm_s16le: 'wav', pcm_s24le: 'wav' };

async function ff(args) { return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]); }

/** Join multiple part files of one track losslessly. */
async function joinParts(parts, container, dir) {
  if (parts.length === 1) return parts[0];
  const binaryConcat = () => {
    const out = path.join(dir, `joined.${container}`); const fd = fs.openSync(out, 'w');
    for (const p of parts) fs.writeSync(fd, fs.readFileSync(p)); fs.closeSync(fd); return out;
  };
  if (!hasFfmpeg()) return binaryConcat();
  // concat demuxer re-bases timestamps across discontinuities; stream copy only.
  const list = path.join(dir, 'concat.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const out = path.join(dir, 'joined.mkv');
  const r = await ff(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', out]);
  if (r.code !== 0) { if (['ts', 'aac', 'mp3'].includes(container)) return binaryConcat(); throw new Error('ffmpeg concat failed: ' + r.err.slice(-400)); }
  return out;
}

const codecsOf = info => (info?.streams || []).map(s => s.codec_name).filter(Boolean);

/**
 * tracks: { video?: {parts, container}, audio?: {parts, container}, subs?: [{parts|file, language}] }
 * Returns { files: [...], warnings: [...] }
 */
export async function finalize(tracks, outBase, { tmpDir, log, expectedDuration } = {}) {
  const warnings = []; const files = [];
  const v = tracks.video ? await joinParts(tracks.video.parts, tracks.video.container, path.join(tmpDir, 'video')) : null;
  const a = tracks.audio ? await joinParts(tracks.audio.parts, tracks.audio.container, path.join(tmpDir, 'audio')) : null;

  if (!hasFfmpeg()) {
    warnings.push('ffmpeg not found — saved raw streams without remuxing (still lossless). Install ffmpeg for a single MP4.');
    for (const [t, f] of [['', v], ['.audio', a]]) if (f) { const out = uniquePath(`${outBase}${t}${path.extname(f)}`); fs.copyFileSync(f, out); files.push(out); }
  } else {
    const inputs = [v, a].filter(Boolean);
    const infos = await Promise.all(inputs.map(probe));
    const all = infos.flatMap(codecsOf);
    const hasVideo = infos.some(i => i?.streams?.some(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1));
    let exts;
    if (!hasVideo) { const ac = all.find(c => AUDIO_EXT[c]); exts = [AUDIO_EXT[ac] || 'mka', 'mka']; }
    else if (all.every(c => WEBM_OK.has(c))) exts = ['webm', 'mkv'];
    else exts = ['mp4', 'mkv'];
    let ok = false;
    for (const ext of [...new Set(exts)]) {
      const out = uniquePath(`${outBase}.${ext}`);
      const args = [];
      inputs.forEach(f => args.push('-i', f));
      if (inputs.length === 2) args.push('-map', '0:v?', '-map', '0:a?', '-map', '1:a');
      else args.push('-map', '0:v?', '-map', '0:a?');
      args.push('-c', 'copy', '-map_chapters', '-1');
      if (ext === 'mp4' || ext === 'm4a') args.push('-movflags', '+faststart');
      if (ext === 'opus' || ext === 'ogg') args.push('-f', 'ogg');
      args.push(out);
      let r = await ff(args);
      if (r.code !== 0) { fs.rmSync(out, { force: true }); r = await ff(['-fflags', '+genpts', ...args]); }
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) { files.push(out); ok = true; break; }
      fs.rmSync(out, { force: true });
      log?.debug(`remux to .${ext} failed: ${r.err.slice(-300)}`);
    }
    if (!ok) {
      warnings.push('remux failed; kept raw stream files (lossless)');
      for (const [t, f] of [['', v], ['.audio', a]]) if (f) { const out = uniquePath(`${outBase}${t}${path.extname(f)}`); fs.copyFileSync(f, out); files.push(out); }
    }
    // integrity check
    const info = files[0] && await probe(files[0]);
    const dur = Number(info?.format?.duration || 0);
    if (!info) warnings.push('output could not be probed — file may be damaged');
    else if (expectedDuration && dur && Math.abs(dur - expectedDuration) > Math.max(2, expectedDuration * 0.03))
      warnings.push(`duration ${dur.toFixed(1)}s differs from expected ${expectedDuration.toFixed(1)}s`);
  }

  for (const [i, s] of (tracks.subs || []).entries()) {
    const ext = s.container || 'vtt'; const out = uniquePath(`${outBase}.${s.language || 'sub' + i}.${ext}`);
    if (s.file) fs.copyFileSync(s.file, out);
    else if (ext === 'vtt') {
      // concatenate WebVTT segments, keeping a single header
      const body = s.parts.map((p, k) => { const t = fs.readFileSync(p, 'utf8'); return k === 0 ? t : t.replace(/^\uFEFF?WEBVTT[^\n]*\n(?:[^\n]+\n)*\n?/, ''); }).join('\n');
      fs.writeFileSync(out, body);
    } else { fs.writeFileSync(out, Buffer.concat(s.parts.map(p => fs.readFileSync(p)))); }
    files.push(out);
  }
  return { files, warnings };
}
