"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type PlayerHandle = {
  time(): number;
  duration(): number;
  playing(): boolean;
  rate(): number;
  seek(t: number): void;
  pause(): void;
  play(): void;
};

/* ------------------------------------------------------------------ YouTube (official embed) */

declare global {
  interface Window {
    YT?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytReady: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytReady;
}

const YT_ERRORS: Record<number, string> = {
  2: "The video id is invalid.",
  5: "This video cannot be played in an HTML5 player.",
  100: "The video was removed or made private.",
  101: "The uploader does not allow this video to be embedded.",
  150: "The uploader does not allow this video to be embedded.",
  153: "The embed request was missing its referrer; open this page from http://localhost:3000.",
};

export const YouTubePlayer = forwardRef<PlayerHandle, { videoId: string; onError?: (msg: string) => void }>(
  function YouTubePlayer({ videoId, onError }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const player = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    useEffect(() => {
      let disposed = false;
      // The YT API replaces its target element, so give it a child React does not own.
      const target = document.createElement("div");
      host.current?.appendChild(target);
      void loadYouTubeApi().then(() => {
        if (disposed) return;
        player.current = new window.YT.Player(target, {
          videoId,
          width: "100%",
          height: "100%",
          // Official player, unmodified. Keyboard control is off so our 1/2/3 mark keys work.
          playerVars: { rel: 0, playsinline: 1, disablekb: 1, origin: window.location.origin },
          events: {
            onError: (e: { data: number }) =>
              onErrorRef.current?.(YT_ERRORS[e.data] || `Player error ${e.data}`),
          },
        });
      });
      const container = host.current;
      return () => {
        disposed = true;
        try {
          player.current?.destroy?.();
        } catch {
          /* already gone */
        }
        player.current = null;
        if (container) container.innerHTML = "";
      };
    }, [videoId]);

    useImperativeHandle(ref, () => ({
      time: () => player.current?.getCurrentTime?.() ?? 0,
      duration: () => player.current?.getDuration?.() ?? 0,
      playing: () => player.current?.getPlayerState?.() === 1,
      rate: () => player.current?.getPlaybackRate?.() ?? 1,
      seek: (t) => player.current?.seekTo?.(t, true),
      pause: () => player.current?.pauseVideo?.(),
      play: () => player.current?.playVideo?.(),
    }));

    return (
      <div className="player-frame">
        <div ref={host} />
      </div>
    );
  },
);

/* ------------------------------------------------------------------ own / uploaded files */

export const FilePlayer = forwardRef<PlayerHandle, { src: string; onError?: (msg: string) => void }>(
  function FilePlayer({ src, onError }, ref) {
    const v = useRef<HTMLVideoElement>(null);
    const [, force] = useState(0);
    useImperativeHandle(ref, () => ({
      time: () => v.current?.currentTime ?? 0,
      duration: () => (v.current && isFinite(v.current.duration) ? v.current.duration : 0),
      playing: () => !!v.current && !v.current.paused && !v.current.ended,
      rate: () => v.current?.playbackRate ?? 1,
      seek: (t) => {
        if (v.current) v.current.currentTime = t;
        force((x) => x + 1);
      },
      pause: () => v.current?.pause(),
      play: () => void v.current?.play(),
    }));
    return (
      <div className="player-frame">
        <video ref={v} src={src} controls playsInline preload="metadata" onError={() => onError?.("This file could not be played in the browser.")} />
      </div>
    );
  },
);
