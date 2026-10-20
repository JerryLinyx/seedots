# YouTube acquisition port

Goal: Bring trace-mvp's yt-dlp + EJS/Node acquisition into mediagrab's CLI and local UI while preserving stream-copy downloads.

Design: Route recognized YouTube single-video URLs through a dedicated adapter before browser sniffing. Resolve formats afresh on download so signed URLs do not expire between analysis and download. Leave other sites on existing HLS/DASH/direct/MSE paths. A generic yt-dlp fallback would expand behavior unnecessarily; copying the Python service would duplicate jobs and add unwanted transcoding.

Implementation:
1. Add src/youtube.mjs: bounded cancellable child process; isolated yt-dlp config; explicit binary/Python selection; single VOD validation; safe metadata; quality cap; fragment retry/resume; stream-copy merge; ffprobe verification.
2. Connect analyze/fetchCandidate and expose CLI options and UI labels. Keep errors explicit, never fall back to MSE for protected or rejected YouTube resources.
3. Add deterministic adapter tests with a fake executable and real ffmpeg media; cover routing, format selection, failures, cancellation and output verification. Run original core/e2e suites and attempt a public YouTube smoke test.
4. Document dependencies, preserved features, intentional omissions and observed validation limits.

Port: local EJS + Node runtime, no playlist expansion, no inherited yt-dlp config/plugins, parallel fragments, retry/resume, metadata and error classification. Do not port forced H.264 preference, lossy conversion, ASR WAV, SQLite task ownership, or the old 720p/2h/512MiB application limits.
