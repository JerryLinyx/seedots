#!/usr/bin/env node
// mediagrab — detect audio/video on a web page and download it losslessly.
import path from 'node:path';
import { grab, parseHeaderArgs } from '../src/engine.mjs';
import { Logger } from '../src/util.mjs';
import { hasFfmpeg } from '../src/mux.mjs';

const HELP = `mediagrab <page-or-media-url> [options]
       mediagrab serve [--port 7788] [-o dir]        local web UI

Detection
  -l, --list              only list detected media, don't download
      --wait <s>          max seconds to watch the page (default 25)
      --headful           show the browser window (log in, solve captchas, click play)
      --profile <dir>     persistent browser profile (keeps logins between runs)
      --browser <name>    chrome | msedge | chromium (default: try chrome, then msedge, then bundled)
      --cookies <file>    Netscape cookies.txt to load
  -H, --header "K: V"     extra request header (repeatable)
      --no-browser        treat the URL as a direct media/manifest link
      --ytdlp <path>      yt-dlp binary (or a python with yt_dlp); default: MEDIAGRAB_YTDLP, PATH
      --no-ytdlp          never use yt-dlp
      --prefer-ytdlp      try yt-dlp before page sniffing for any site
      --browser-cookies <chrome|safari|firefox|edge>
                          let yt-dlp read this browser's login cookies (opt-in; for YouTube bot checks)
      --compat            prefer H.264 + AAC (plays everywhere) over VP9/AV1 when both exist

Download
  -p, --pick <ids|all>    which candidates to download (default: best)
  -q, --quality <q>       best | worst | max height e.g. 1080 (default best)
      --audio-lang <xx>   preferred audio language for multi-audio streams
      --subs              also save subtitles
  -o, --out <dir>         output directory (default ./downloads)
  -n, --name <name>       output file name (without extension)
  -j, --concurrency <n>   parallel connections/segments (default 8)
      --retries <n>       retries per request (default 10)
      --allow-gaps        skip segments that keep failing instead of aborting
      --live-duration <s> for live HLS: stop after N seconds (default: until it ends / Ctrl+C)
      --capture           force MSE capture (record what the player buffers)
      --no-capture        never fall back to MSE capture
      --rate <n>          capture playback speed (default 16)
      --keep-temp         keep temporary segment files
  -v, --verbose           --json   print a JSON summary to stdout
`;

function parseArgs(argv) {
  const o = { headers: [], _: [] };
  const flag = { '--list': 'listOnly', '-l': 'listOnly', '--headful': 'headful', '--subs': 'subs', '--no-browser': 'noBrowser', '--allow-gaps': 'allowGaps',
    '--keep-temp': 'keepTemp', '--prefer-ytdlp': 'preferExtractor', '--compat': 'compat', '-v': 'verbose', '--verbose': 'verbose', '--json': 'json', '--capture': 'capture', '--force-browser': 'forceBrowser', '-h': 'help', '--help': 'help' };
  const val = { '--wait': 'wait', '--profile': 'profile', '--browser': 'channel', '--cookies': 'cookiesFile', '-p': 'pick', '--pick': 'pick', '-q': 'quality', '--quality': 'quality',
    '--audio-lang': 'audioLang', '-o': 'outDir', '--out': 'outDir', '-n': 'filename', '--name': 'filename', '-j': 'concurrency', '--concurrency': 'concurrency', '--retries': 'retries',
    '--live-duration': 'liveDuration', '--ytdlp': 'ytdlp', '--browser-cookies': 'browserCookies', '--rate': 'rate', '--port': 'port', '--chunk-size': 'chunkSize' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-H' || a === '--header') o.headers.push(argv[++i]);
    else if (a === '--no-capture') o.capture = false;
    else if (a === '--no-ytdlp') o.ytdlp = false;
    else if (flag[a]) o[flag[a]] = true;
    else if (val[a]) o[val[a]] = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  for (const k of ['wait', 'concurrency', 'retries', 'liveDuration', 'rate', 'port', 'chunkSize']) if (o[k] != null) o[k] = Number(o[k]);
  if (o.channel === 'chromium') o.channel = undefined, o.bundled = true;
  o.headers = parseHeaderArgs(o.headers);
  return o;
}

const o = parseArgs(process.argv.slice(2));
if (o.help || !o._.length) { process.stdout.write(HELP); process.exit(o.help ? 0 : 1); }
const log = new Logger({ verbose: o.verbose });
if (o.bundled) o.channel = 'chromium-bundled';

if (o._[0] === 'serve') {
  const { serve } = await import('../src/server.mjs');
  await serve({ port: o.port || 7788, outDir: path.resolve(o.outDir || 'downloads'), log, defaults: o });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
} else {
  if (!hasFfmpeg()) log.warn('ffmpeg/ffprobe not found on PATH — streams will be saved without the final remux step (still lossless). macOS: brew install ffmpeg');
  const ac = new AbortController(); let stops = 0;
  process.on('SIGINT', () => { if (++stops > 1) process.exit(130); log.warn('stopping… (Ctrl+C again to force quit)'); ac.abort(); });
  try {
    const { results, analysis } = await grab(o._[0], { ...o, outDir: path.resolve(o.outDir || 'downloads'), log, signal: ac.signal });
    if (o.json) process.stdout.write(JSON.stringify({ title: analysis.title, candidates: analysis.candidates.map(({ cookies, ...c }) => ({ ...c, inline: c.inline ? `[${c.inline.length} chars]` : undefined })), results }, null, 2) + '\n');
    process.exit(results.some(r => r.error) ? 2 : 0);
  } catch (e) { log.warn(e.message); if (o.verbose) console.error(e.stack); process.exit(1); }
}
