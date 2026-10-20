# mediagrab

给一个网页（或媒体）链接，自动识别其中的音视频并**无损**下载。思路参考了对 CocoCut / 猫抓类浏览器扩展的逆向分析，但全部为独立实现，不含其代码；以命令行 + 本地网页界面的形式运行在你自己的电脑上。

## 安装（macOS）

```bash
brew install ffmpeg          # 或 conda install -c conda-forge ffmpeg；用于最终无损封装 (-c copy)
cd mediagrab
npm install                  # 只装 playwright-core，不会下载浏览器
```

**YouTube 等平台**需要 yt-dlp（含 EJS 签名求解组件）。已有 trace-mvp 的虚拟环境可以直接复用：

```bash
export MEDIAGRAB_YTDLP=/Users/linyuxuan/Documents/Codex/2026-10-08/x/trace-mvp/.venv/bin/yt-dlp
# 或者单独安装：python3 -m pip install -U "yt-dlp[default]"
```

浏览器默认直接用你电脑上已安装的 **Google Chrome**（自带 H.264/AAC 解码，播放器行为最接近真实用户）。没有 Chrome 时会依次尝试 Edge 和 Playwright 自带的 Chromium（`npx playwright install chromium`）。

需要 Node.js ≥ 20。

## 用法

```bash
# 识别并下载最佳画质
node bin/mediagrab.mjs "https://example.com/some/video/page"

# 只看识别结果
node bin/mediagrab.mjs "https://…" --list

# 选第 2、3 个候选；限制 1080p；带字幕
node bin/mediagrab.mjs "https://…" -p 2,3 -q 1080 --subs

# 需要登录的网站：弹出浏览器手动登录一次，profile 会保留登录态
node bin/mediagrab.mjs "https://…" --headful --profile ~/.mediagrab-profile

# 已知是 m3u8 / mpd / mp4 直链（跳过浏览器）；可附加请求头
node bin/mediagrab.mjs "https://cdn…/master.m3u8" -H "Referer: https://site/"

# 直播：录 10 分钟
node bin/mediagrab.mjs "https://…/live.m3u8" --live-duration 600

# YouTube：自动交给 yt-dlp 解析，下载最高画质原始码流
node bin/mediagrab.mjs "https://www.youtube.com/watch?v=…"
# 遇到"请确认你不是机器人"：允许 yt-dlp 读取本机 Chrome 的登录 Cookie（需要你主动开启）
node bin/mediagrab.mjs "https://www.youtube.com/watch?v=…" --browser-cookies chrome
# 想要到处都能播放的 H.264 + AAC（仍是原始码流，只是挑选格式）
node bin/mediagrab.mjs "https://www.youtube.com/watch?v=…" --compat

# 本地网页界面（http://127.0.0.1:7788）
node bin/mediagrab.mjs serve -o ~/Downloads/mediagrab
```

完整参数见 `node bin/mediagrab.mjs --help`。

## 工作原理

| 层 | 做法 | 对应 CocoCut 的机制 |
|---|---|---|
| 网络嗅探 | Playwright 监听**所有 frame** 的每个响应，按扩展名 / Content-Type / Content-Disposition / 响应体首字节（`#EXTM3U`、`<MPD`）分类，记录 Referer/Origin/Cookie/Authorization | `webRequest.onSendHeaders` + `onResponseStarted` |
| 页面注入 | 在页面脚本执行前注入：挂钩 `JSON.parse` / `Response.json`（从播放器配置里挖 URL 和内嵌 m3u8）、`URL.createObjectURL`（页面里拼出来的 blob 播放列表）、`HTMLMediaElement.src`、`MediaSource.addSourceBuffer` | deepsearch.js / pagehelper.js |
| 触发播放 | 自动静音并 `play()`，点击常见播放按钮（video.js、JW、Plyr、DPlayer、西瓜等），让懒加载的播放器真正发出请求 | — |
| DOM 扫描 | `<video>/<audio>/<source>/<track>`、`og:video`、页面里的媒体下载链接 | — |
| 去重排序 | 解析 master/MPD，隐藏子码率和分片；按分辨率 > 码率 > 文件大小排序 | 分片归类 `isSegment` |
| HLS | 选最高码率变体 + 匹配的独立音轨/字幕；并发下载分片；AES-128 解密（每段 IV / 按序号推导 IV）；`EXT-X-MAP`、`BYTERANGE`、`DISCONTINUITY` 分段处理；直播滑动窗口轮询 | m3u8dl.js（hls.js + WebCrypto） |
| DASH | 自写 XML 解析；支持 SegmentTemplate（`$Number$`/`$Time$`/Timeline）、SegmentList、SegmentBase；最佳视频 + 最佳音频；按时长推算的分片数会自动探测尾部多出的分片 | mpd.js（dash.js） |
| 直链 | Range 探测 → 多连接分块并行下载，`.part` + 状态文件断点续传 | 背景页 4MB 分块 × 5 连接 |
| 封装 | `ffmpeg -c copy` 只做重新封装、**从不重新编码**；mp4 → mkv → 原始流 逐级降级；ffprobe 校验时长 | mux.js / mediabunny / ffmpeg.wasm |
| 站点解析 | YouTube、哔哩哔哩、X、TikTok、Instagram、Vimeo 等直接交给 yt-dlp；其他网站若页面里抓不到，也会让 yt-dlp 的通用解析器再试一次 | — |
| 兜底 0 | yt-dlp 自己下载失败或**悄悄丢了分片**时（ffmpeg 遇错跳过分片却返回成功，已用测试复现），改为"yt-dlp 只解析、mediagrab 负责传输"的混合模式 | — |
| 兜底 1 | Node 直连被拒（401/403、反爬）时，改为**在页面内用浏览器自己的 fetch** 下载（真实 TLS 指纹 + Cookie + CORS 上下文），已下的分片继续沿用 | — |
| 兜底 2 | 地址被混淆、抓不到任何 URL 时，**录制 MSE 缓冲**：以最高 16 倍速播放，逐字节保存每次 `appendBuffer` 的数据，重建音视频轨后无损封装 | pagehelper_asset.js（缓存捕获） |

## 容错

- 每个请求：连接超时 + 读取空闲超时；408/425/429/5xx/CDN 52x 指数退避重试，遵守 `Retry-After`；401/403/404 先软重试两次（CDN 边缘偶发）
- 响应被截断或连接中断：从已收到的字节处用 Range **续传**，而不是从头再来
- 服务器忽略 Range 时自动丢弃多余前缀
- 分片持续失败：重新拉取播放列表（处理过期 token / 轮换 URL），按序号换新地址重试；仍失败可 `--allow-gaps` 跳过并在结果中报告
- 进程被杀 / 断网：临时目录按 URL 哈希命名，再次运行同一命令会跳过已完成的分片/分块
- 返回 HTML（登录页、防盗链页）会被识别为错误，而不是存成假视频
- MSE 录制结果无法解析时直接报错，不会把损坏文件当成功

## 无损验证

`test/` 下有完整的本地测试环境：`gen.sh` 用 ffmpeg 生成多码率 HLS（TS + AES-128）、fMP4 分离音轨 HLS、两种 DASH、渐进 MP4 和 WebM（MSE）样本；`server.mjs` 是带故障注入的服务器（随机 500/503/429、连接重置、响应截断、Referer 校验、模拟反爬）。

```bash
npm run fixtures
npm run test:core     # 7 个下载场景，FLAKY=0.5 时（一半请求出错）也全部通过
npm run test:e2e      # 12 个整页场景（真实浏览器），FLAKY=0.25
npm run test:ytdlp    # yt-dlp 集成：单元 + 12 个场景（未安装 yt-dlp 时只跑单元测试）
```

校验方式是逐包比较：输出文件中每个压缩包的 MD5 与源编码文件一一相同（`pk`）；TS 封装的 H.264 因为码流格式不同（Annex-B）无法逐包比对，改为比对每一帧解码后的 MD5（`fr`），同样必须完全一致。

## 与 trace-mvp 媒体模块的关系

站点解析部分借鉴了 trace-mvp `backend/media.py`：隔离调用 yt-dlp（`--ignore-config --no-plugin-dirs --no-remote-components`）、用 Node 作为 JS 运行时求解 YouTube 签名、先 `--dump-single-json` 检查（播放列表、未开始的直播、DRM 直接拒绝）、把 stderr 归类成可操作的中文错误。

有意不同的地方：trace-mvp 为后续转写把视频统一转成 ≤1080p 的 H.264，这里**从不转码、默认最高画质**；另外在 yt-dlp 外面加了重试层（解析阶段的网络错误 yt-dlp 自己不重试）、输出完整性校验（时长 + ffmpeg 丢分片告警）和混合传输兜底。默认不读取浏览器 Cookie，`--browser-cookies` 需要显式开启。

## 局限

- **DRM 内容不支持**（Widevine / FairPlay / PlayReady，即 `SAMPLE-AES`、非 identity 的 KEYFORMAT、MPD 中的 `ContentProtection`）——会明确报错并跳过。
- YouTube 等平台依赖 yt-dlp；平台改版时需要 `pip install -U "yt-dlp[default]"` 更新。会员 / 私享 / 年龄限制视频需要 `--browser-cookies` 或 `--cookies`。
- 直播 DASH（`type="dynamic"`）暂不支持；直播 HLS 支持。
- MSE 录制模式依赖页面实际播放：耗时约等于 时长 ÷ 倍速；若播放器中途切换清晰度，会提示格式变化，画质取决于播放器当时拿到的码率。
- 请只下载你有权保存的内容，遵守网站条款与当地法律。
