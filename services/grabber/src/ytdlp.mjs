// Site extractor stage backed by yt-dlp (YouTube and ~1800 other sites).
// Adopted from the trace-mvp media module: isolated invocation (--ignore-config, no plugins, no remote components),
// Node as the JS runtime for YouTube's signature challenges (EJS ships with yt-dlp[default]), inspect-before-download,
// and stderr classification into actionable errors. Unlike trace-mvp, nothing is re-encoded: the best streams are
// stream-copied (merged) as-is, and there is no height cap unless asked for.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { sanitizeFilename } from './util.mjs';

// Hosts where a dedicated extractor beats generic page sniffing (signed / SABR / private APIs).
const PREFERRED = [/(^|\.)youtube\.com$/, /(^|\.)youtu\.be$/, /(^|\.)youtube-nocookie\.com$/, /(^|\.)bilibili\.com$/, /(^|\.)b23\.tv$/,
  /(^|\.)twitter\.com$/, /(^|\.)x\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)instagram\.com$/, /(^|\.)facebook\.com$/, /(^|\.)fb\.watch$/,
  /(^|\.)vimeo\.com$/, /(^|\.)twitch\.tv$/, /(^|\.)dailymotion\.com$/, /(^|\.)soundcloud\.com$/, /(^|\.)reddit\.com$/, /(^|\.)v\.redd\.it$/];

export function prefersExtractor(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return PREFERRED.some(re => re.test(h)); } catch { return false; }
}

export class ExtractorError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; if (code === 'protected_media') this.drm = true; }
}

let cached;
/** Locate yt-dlp: --ytdlp / MEDIAGRAB_YTDLP, `yt-dlp` on PATH, then `python3 -m yt_dlp`. */
export function findYtdlp(explicit) {
  if (cached !== undefined && !explicit) return cached;
  const tries = [];
  const want = explicit || process.env.MEDIAGRAB_YTDLP;
  if (want) tries.push(/python[\d.]*$/.test(want) ? [want, ['-m', 'yt_dlp']] : [want, []]);
  tries.push(['yt-dlp', []], ['python3', ['-m', 'yt_dlp']]);
  const home = os.homedir();
  for (const p of [path.join(home, '.local/bin/yt-dlp'), '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) tries.push([p, []]);
  let found = null;
  for (const [cmd, pre] of tries) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(r.stdout.trim())) { found = { cmd, pre, version: r.stdout.trim() }; break; }
  }
  if (!explicit) cached = found;
  return found;
}

function baseArgs(opts = {}) {
  const a = ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist',
    '--socket-timeout', '20', '--retries', String(opts.retries ?? 10), '--fragment-retries', String(opts.retries ?? 10),
    '--extractor-retries', '3', '--file-access-retries', '5', '--no-colors',
    '--js-runtimes', `node:${process.execPath}`];
  if (opts.cookiesFile) a.push('--cookies', opts.cookiesFile);
  if (opts.browserCookies) a.push('--cookies-from-browser', opts.browserCookies);
  for (const [k, v] of Object.entries(opts.headers || {})) if (!/^(cookie|user-agent)$/i.test(k)) a.push('--add-headers', `${k}:${v}`);
  return a;
}

const TRANSIENT = /network error|incompleteread|timed out|timeout|connection (reset|refused|aborted)|remote end closed|temporary failure|name resolution|eof occurred|ssl|http error 5\d\d|bad gateway|service unavailable|unable to download (webpage|json|video data|m3u8|mpd)|got error|read error|broken pipe/i;
const ERRORS = [
  [/sign in to confirm|confirm you.?re not a bot|login required|use --cookies|authentication|members-only|join this channel|private video|this video is private|age.?restricted|inappropriate for some users/i,
    'access_required', '平台要求登录或人机验证。可以加 --browser-cookies chrome 使用本机 Chrome 的登录状态，或用 --cookies 提供 cookies.txt。'],
  [/drm|widevine|playready|fairplay/i, 'protected_media', '该资源受 DRM 保护，无法保存。'],
  [/unsupported url/i, 'unsupported_url', '解析器不支持这个页面。'],
  [/video unavailable|has been removed|no longer available|does not exist|404/i, 'unavailable', '视频不存在、已删除或在当前地区不可用。'],
  [/not available in your country|geo.?restrict/i, 'geo_blocked', '视频在当前地区不可用。'],
  [/premieres in|will begin in|this live event will begin|is_upcoming/i, 'upcoming', '直播或首映还没开始。'],
  [/requested format is not available/i, 'format_unavailable', '没有符合画质条件的格式，换一个画质上限再试。'],
  [/http error 429|too many requests/i, 'rate_limited', '平台限制了请求频率，请稍后再试。'],
  [TRANSIENT, 'network', '网络或服务器暂时出错。'],
  [/http error 403|forbidden/i, 'remote_rejected', '平台拒绝了下载请求（403）。可以稍后重试，或使用 --browser-cookies chrome。'],
  [/no such file|is not recognized|enoent/i, 'missing_dependency', '找不到 yt-dlp。'],
  [/ffmpeg.*not (found|installed)|ffprobe.*not found/i, 'missing_dependency', '合并音视频需要 ffmpeg，请先安装（brew install ffmpeg）。'],
  [/(n|nsig|signature).*(challenge|extraction failed)|javascript runtime|js runtime/i, 'js_challenge', 'YouTube 签名校验没能通过：确认 yt-dlp 为最新版并装有 yt-dlp-ejs（pip install -U "yt-dlp[default]"）。'],
];

export function classifyError(lines) {
  const text = lines.join('\n');
  for (const [re, code, msg] of ERRORS) if (re.test(text)) { const e = new ExtractorError(code, msg, text.slice(-600)); e.retryable = code === 'network' || code === 'rate_limited' || code === 'remote_rejected'; return e; }
  const detail = [...lines].reverse().find(l => /error/i.test(l)) || lines.at(-1) || 'yt-dlp 未成功结束';
  return new ExtractorError('extractor_failed', detail.replace(/https?:\/\/\S+/g, '[链接]').slice(-400), text.slice(-600));
}

function run(yt, args, { signal, onLine, capture = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(yt.cmd, [...yt.pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const errs = []; let out = ''; let buf = ''; let ebuf = ''; let killed = false;
    const kill = () => { killed = true; try { process.platform !== 'win32' ? process.kill(-p.pid, 'SIGTERM') : p.kill(); } catch {} setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
    const onAbort = () => kill(); signal?.addEventListener('abort', onAbort, { once: true });
    const t = timeout ? setTimeout(kill, timeout) : null;
    p.stdout.on('data', d => {
      if (capture) { out += d; if (out.length > 64 << 20) kill(); return; }
      buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); onLine?.(l, 'out'); }
    });
    p.stderr.on('data', d => { ebuf += d; let i; while ((i = ebuf.indexOf('\n')) >= 0) { const l = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1); if (l) { errs.push(l); if (errs.length > 60) errs.shift(); onLine?.(l, 'err'); } } });
    p.on('error', e => { clearTimeout(t); reject(classifyError([String(e.message)])); });
    p.on('close', code => {
      clearTimeout(t); signal?.removeEventListener('abort', onAbort);
      if (buf) onLine?.(buf, 'out');
      if (killed && signal?.aborted) return reject(new ExtractorError('cancelled', '已取消'));
      if (killed) return reject(new ExtractorError('timeout', '解析超时'));
      if (code !== 0) return reject(classifyError(errs));
      resolve(out);
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Re-run yt-dlp on transient failures with backoff; downloads resume thanks to --continue + kept .part files. */
async function withRetries(fn, { attempts = 6, log, signal, what }) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!e.retryable || i + 1 >= attempts || signal?.aborted) throw e;
      const wait = Math.min(30000, (e.code === 'rate_limited' ? 5000 : 800) * 2 ** i) * (0.7 + Math.random() * 0.6);
      log?.warn(`${what}: ${e.message}，${Math.round(wait / 1000)} 秒后重试（${i + 1}/${attempts - 1}）`);
      await sleep(wait);
    }
  }
}

/** Inspect a URL without downloading. Returns yt-dlp's info dict. */
export async function inspect(url, opts = {}) {
  const yt = opts.yt || findYtdlp(opts.ytdlp);
  if (!yt) throw new ExtractorError('missing_dependency', '没有找到 yt-dlp（pip install -U "yt-dlp[default]"，或用 MEDIAGRAB_YTDLP 指向它）');
  const out = await withRetries(() => run(yt, [...baseArgs(opts), '--skip-download', '--dump-single-json', '--no-warnings', '--', url], { signal: opts.signal, capture: true, timeout: 180000 }),
    { attempts: opts.retries ? Math.min(opts.retries, 8) : 6, log: opts.log, signal: opts.signal, what: 'yt-dlp 解析' });
  let info; try { info = JSON.parse(out); } catch { throw new ExtractorError('extractor_failed', '解析结果不是有效的 JSON'); }
  if (info._type === 'playlist' || info._type === 'multi_video' || Array.isArray(info.entries)) throw new ExtractorError('playlist', '这是一个播放列表，请提供单个视频的链接。');
  if (info.live_status === 'is_upcoming') throw new ExtractorError('upcoming', '直播或首映还没开始。');
  if (info.has_drm || (info.formats || []).length && info.formats.every(f => f.has_drm)) throw new ExtractorError('protected_media', '该资源受 DRM 保护，无法保存。');
  return info;
}

export function infoToCandidate(info, url) {
  const fm = (info.formats || []).filter(f => !f.has_drm);
  const vids = fm.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
  const best = vids.sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)))[0];
  const audios = fm.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const langs = [...new Set(audios.map(f => f.language).filter(Boolean))];
  return {
    id: 1, kind: 'site', url: info.webpage_url || url, title: info.title || 'video', via: ['yt-dlp'], headers: {},
    summary: {
      extractor: info.extractor_key || info.extractor, width: best?.width || info.width, height: best?.height || info.height,
      duration: info.duration, uploader: info.uploader || info.channel, chapters: (info.chapters || []).length,
      formats: fm.length, heights: [...new Set(vids.map(f => f.height))].sort((a, b) => b - a), audioLangs: langs,
      live: info.is_live || info.live_status === 'is_live', vcodec: best?.vcodec,
      subtitles: Object.keys(info.subtitles || {}).filter(k => k !== 'live_chat'),
    },
  };
}

export function formatSelector({ quality = 'best', audioLang, compat } = {}) {
  const h = parseInt(quality, 10);
  const vf = Number.isFinite(h) ? `[height<=?${h}]` : '';
  const af = audioLang ? `[language^=${audioLang.replace(/[^\w-]/g, '')}]` : '';
  if (quality === 'worst') return 'wv*+wa/w';
  const parts = [];
  if (compat) parts.push(`bv*${vf}[vcodec^=avc1]+ba${af}[ext=m4a]`, `bv*${vf}[vcodec^=avc1]+ba[ext=m4a]`, `b${vf}[ext=mp4]`);
  if (af) parts.push(`bv*${vf}+ba${af}`);
  parts.push(`bv*${vf}+ba`, `b${vf}`, `bv*${vf}`);
  if (vf) parts.push('bv*+ba/b');
  return parts.join('/');
}

/** Download via yt-dlp. Emits mosaic-compatible progress per stream (fragment-level when available). */
export async function downloadSite(cand, opts = {}) {
  const { outDir = 'downloads', log, signal } = opts;
  const yt = findYtdlp(opts.ytdlp);
  if (!yt) throw new ExtractorError('missing_dependency', '没有找到 yt-dlp');
  fs.mkdirSync(outDir, { recursive: true });
  const name = sanitizeFilename(opts.filename || cand.title || 'video').replace(/%/g, '%%');
  const tmp = path.join(outDir, '.mediagrab-tmp'); fs.mkdirSync(tmp, { recursive: true });
  const listFile = path.join(tmp, `files-${process.pid}-${Date.now()}.txt`);
  const args = [...baseArgs(opts), '--format', formatSelector(opts), '--merge-output-format', 'mp4/webm/mkv',
    '--concurrent-fragments', String(Math.min(opts.concurrency ?? 8, 16)), '--continue', '--no-overwrites',
    '--paths', `home:${outDir}`, '--paths', `temp:${tmp}`, '--output', `${name}.%(ext)s`,
    // --print would imply --quiet, which also hides ffmpeg's warnings about dropped segments: write paths to a file instead
    '--embed-metadata', '--embed-chapters', '--print-to-file', 'after_move:%(filepath)s', listFile,
    '--newline', '--progress', '--progress-template', 'download:MGPROG:%(progress)j\t%(info.vcodec)s\t%(info.acodec)s\t%(info.format_id)s'];
  if (opts.subs) args.push('--write-subs', '--sub-langs', opts.audioLang ? `${opts.audioLang}.*,en.*,zh.*` : 'all,-live_chat');
  if (opts.liveDuration) args.push('--download-sections', `*0-${opts.liveDuration}`);
  args.push('--', cand.url);
  const files = []; const warnings = []; let lastFmt = null; const seen = new Map(); let lossy = null;
  const LOSS = /failed too many times, skipping|stream ends prematurely|failed to open segment|error when loading first segment|unable to open resource|invalid data found when processing input|connection reset|error in the pull function|i\/o error|server returned [45]\d\d|http error [45]\d\d|will reconnect|packet corrupt|corrupt input packet/i;
  log?.info(`yt-dlp ${yt.version}: ${cand.summary?.extractor || ''} ${cand.summary?.height ? cand.summary.width + 'x' + cand.summary.height : ''}`.trim());
  await withRetries(() => run(yt, args, {
    signal, onLine: (l, ch) => {
      if (l.startsWith('MGPROG:')) {
        const [j, vc, ac, fid] = l.slice(7).split('\t');
        let p; try { p = JSON.parse(j); } catch { return; }
        const label = vc && vc !== 'none' ? 'video' : (ac && ac !== 'none' ? 'audio' : 'video');
        if (fid !== lastFmt) { lastFmt = fid; log?.info(`  ${label}: format ${fid} (${vc !== 'none' ? vc : ''}${vc !== 'none' && ac !== 'none' ? ' + ' : ''}${ac !== 'none' ? ac : ''})`); }
        const bytes = p.downloaded_bytes || 0;
        if (p.fragment_count) { seen.set(label, true); log?.progress({ label, done: Math.min(p.fragment_index || 0, p.fragment_count), total: p.fragment_count, bytes }); }
        else { const tot = p.total_bytes || p.total_bytes_estimate; log?.progress({ label, done: tot ? Math.min(100, Math.floor(bytes / tot * 100)) : 0, total: tot ? 100 : 0, bytes, unit: 'pct' }); }
        return;
      }
      if (ch === 'err' && LOSS.test(l)) lossy = lossy || l.replace(/^\[\w+ @ 0x[0-9a-f]+\]\s*/, '');
      if (ch === 'err') { if (/^WARNING/.test(l)) { log?.debug(l); if (/ffmpeg|merg/i.test(l)) warnings.push(l.replace(/^WARNING:\s*/, '')); } else log?.debug(l); }
      else if (/^\[Merger\]/.test(l)) log?.info('  合并音视频（无损封装）');
    },
  }), { attempts: opts.retries ? Math.min(opts.retries, 10) : 8, log, signal, what: 'yt-dlp 下载' });
  try { for (const l of fs.readFileSync(listFile, 'utf8').split('\n')) if (l.trim()) files.push(l.trim()); fs.rmSync(listFile, { force: true }); } catch {}
  if (!files.length) throw new ExtractorError('missing_media', 'yt-dlp 结束了，但没有产出文件');
  const main = files.at(-1);
  if (lossy) { fs.rmSync(main, { force: true }); throw new ExtractorError('incomplete', `下载过程中有分片丢失（${lossy.slice(0, 120)}）`); }
  // yt-dlp's ffmpeg-delegated downloads can silently skip broken segments and still exit 0: verify the duration
  const expected = cand.summary?.duration;
  if (expected && !opts.liveDuration) {
    const { probe } = await import('./mux.mjs');
    const pr = await probe(main); const got = Number(pr?.format?.duration || 0);
    // segment loss only ever shortens the output; platforms may round the reported duration, so be one-sided
    if (!pr || got < expected - 0.5 - expected * 0.002 || got > expected + 2 + expected * 0.01) {
      fs.rmSync(main, { force: true });
      throw new ExtractorError('incomplete', `输出时长 ${got.toFixed(1)} 秒，与源 ${expected.toFixed(1)} 秒不一致（有分片丢失）`);
    }
  }
  if (opts.subs) {
    const base = main.replace(/\.[^.]+$/, '');
    for (const f of fs.readdirSync(path.dirname(main))) { const full = path.join(path.dirname(main), f); if (full.startsWith(base + '.') && /\.(vtt|srt|ass|ttml|srv\d|json3)$/.test(f)) files.push(full); }
  }
  try { fs.rmdirSync(tmp); } catch {}
  return { files: [...new Set(files)], warnings, kind: 'site', info: { extractor: cand.summary?.extractor, ytdlp: yt.version } };
}

/**
 * Hybrid mode: let yt-dlp do the extraction (signatures, JS challenges, private APIs) and return the exact
 * stream URLs + headers of the formats it would pick, so mediagrab's own resilient transfer engine can fetch them.
 */
export async function resolveFormats(url, opts = {}) {
  const yt = opts.yt || findYtdlp(opts.ytdlp);
  const out = await withRetries(() => run(yt, [...baseArgs(opts), '--format', formatSelector(opts), '--skip-download', '--dump-single-json', '--no-warnings', '--', url],
    { signal: opts.signal, capture: true, timeout: 180000 }), { attempts: 6, log: opts.log, signal: opts.signal, what: 'yt-dlp 解析' });
  const info = JSON.parse(out);
  const picked = info.requested_formats?.length ? info.requested_formats : [info];
  return {
    title: info.title, duration: info.duration,
    formats: picked.map(f => ({
      format_id: f.format_id, url: f.url, manifest_url: f.manifest_url, protocol: f.protocol || '', ext: f.ext,
      kind: f.vcodec && f.vcodec !== 'none' ? 'video' : 'audio', headers: f.http_headers || {},
      fragments: f.fragments ? f.fragments.map(x => x.url || new URL(x.path, f.fragment_base_url).href) : null,
      has_drm: !!f.has_drm,
    })),
  };
}
