#!/usr/bin/env bash
# Generates test fixtures: source encodes + HLS (TS/AES-128, fMP4 + separate audio), DASH, progressive MP4, WebM for MSE.
set -euo pipefail
F="$(cd "$(dirname "$0")" && pwd)/fixtures"
rm -rf "$F" && mkdir -p "$F"/{src,hls_ts,hls_fmp4,dash,dash_num,mse,audio}
cd "$F"
Q="-hide_banner -loglevel error -y"
DUR=16
G="-g 48 -keyint_min 48 -sc_threshold 0 -r 24"

ffmpeg $Q -f lavfi -i "testsrc2=size=1280x720:rate=24:duration=$DUR" -c:v libx264 -preset veryfast -crf 26 $G -pix_fmt yuv420p src/v720.mp4
ffmpeg $Q -f lavfi -i "testsrc2=size=768x432:rate=24:duration=$DUR" -c:v libx264 -preset veryfast -crf 28 $G -pix_fmt yuv420p src/v480.mp4
ffmpeg $Q -f lavfi -i "testsrc2=size=384x216:rate=24:duration=$DUR" -c:v libx264 -preset veryfast -crf 30 $G -pix_fmt yuv420p src/v240.mp4
ffmpeg $Q -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR" -c:a aac -b:a 128k src/a.m4a

# progressive mp4 (direct download)
ffmpeg $Q -i src/v720.mp4 -i src/a.m4a -map 0:v -map 1:a -c copy -movflags +faststart src/prog.mp4
cp src/a.m4a audio/song.m4a

# HLS TS + AES-128, muxed audio, 3 variants
head -c 16 /dev/urandom > hls_ts/k.key
printf 'k.key\n%s/hls_ts/k.key\n%s\n' "$F" "$(openssl rand -hex 16)" > hls_ts/key.info
for v in 720 480 240; do
  ffmpeg $Q -i src/v$v.mp4 -i src/a.m4a -map 0:v -map 1:a -c copy -f hls -hls_time 2 -hls_playlist_type vod \
    -hls_key_info_file hls_ts/key.info -hls_segment_filename "hls_ts/v${v}_%03d.ts" hls_ts/v$v.m3u8
done
cat > hls_ts/master.m3u8 <<EOF
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=384x216,CODECS="avc1.64001e,mp4a.40.2"
v240.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=768x432,CODECS="avc1.64001e,mp4a.40.2"
v480.m3u8
EOF

# HLS fMP4, video-only variants + separate audio rendition
for v in 720 480; do
  ffmpeg $Q -i src/v$v.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "v${v}_init.mp4" -hls_segment_filename "hls_fmp4/v${v}_%03d.m4s" hls_fmp4/v$v.m3u8
done
ffmpeg $Q -i src/a.m4a -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename "aud_init.mp4" -hls_segment_filename "hls_fmp4/aud_%03d.m4s" hls_fmp4/aud.m3u8
cat > hls_fmp4/master.m3u8 <<EOF
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="aud.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=768x432,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
v480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
v720.m3u8
EOF

# DASH: SegmentTimeline and $Number$ variants
ffmpeg $Q -i src/v720.mp4 -i src/v480.mp4 -i src/a.m4a -map 0:v -map 1:v -map 2:a -c copy -f dash -seg_duration 2 \
  -use_template 1 -use_timeline 1 -adaptation_sets "id=0,streams=v id=1,streams=a" dash/manifest.mpd
ffmpeg $Q -i src/v720.mp4 -i src/v480.mp4 -i src/a.m4a -map 0:v -map 1:v -map 2:a -c copy -f dash -seg_duration 2 \
  -use_template 1 -use_timeline 0 -adaptation_sets "id=0,streams=v id=1,streams=a" dash_num/manifest.mpd

# WebM (VP9/Opus) DASH segments, used by the MSE-only page with opaque URLs
ffmpeg $Q -f lavfi -i "testsrc2=size=640x360:rate=24:duration=10" -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=10" \
  -map 0:v -map 1:a -c:v libvpx-vp9 -b:v 400k -deadline realtime -cpu-used 8 -g 48 -keyint_min 48 -c:a libopus -b:a 64k \
  -f dash -seg_duration 2 -dash_segment_type webm -use_template 1 -use_timeline 0 \
  -init_seg_name 'init-$RepresentationID$.webm' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.webm' \
  -adaptation_sets "id=0,streams=v id=1,streams=a" mse/manifest.mpd
echo "fixtures ready in $F"
