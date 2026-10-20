"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

const YT = /(youtube\.com\/(watch|embed|shorts|live)|youtu\.be\/)/i;

export function AddVideo({ initialUrl = "" }: { initialUrl?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const capRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [capName, setCapName] = useState<string | null>(null);

  const trimmed = url.trim();
  const isWeb = !!trimmed && /^https?:\/\//i.test(trimmed) && !YT.test(trimmed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (file) return uploadFile(file);
    if (!trimmed) return setError("Paste a link to a video first.");
    if (isWeb && !rights) return setError("Confirm you can use this video before adding it.");
    setBusy(true);
    try {
      const v = await api.addLink(
        trimmed,
        isWeb ? "I have the right to use this video for my own learning." : undefined,
      );
      router.push(`/learn/${v.media_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the video.");
      setBusy(false);
    }
  }

  async function uploadFile(f: File) {
    setBusy(true);
    try {
      const v = await api.upload(f, capRef.current?.files?.[0] ?? null);
      router.push(`/learn/${v.media_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't upload the file.");
      setBusy(false);
    }
  }

  return (
    <form className="adder" onSubmit={submit}>
      <label htmlFor="video-url" className="sr-only">
        Video link
      </label>
      <div className="adder-row">
        <input
          id="video-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder={file ? file.name : "Paste a YouTube link or a page with a video"}
          value={file ? "" : url}
          disabled={!!file}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : file ? "Upload and start" : "Start watching"}
        </button>
      </div>
      {isWeb && (
        <label className="rights">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
          <span>
            I have the right to use this video for my own learning. SeeDots saves a private copy for you; videos with
            copy protection can't be added.
          </span>
        </label>
      )}
      <div className="adder-meta">
        {file ? (
          <>
            <span>Captions (optional, .vtt or .srt)</span>
            <button type="button" onClick={() => capRef.current?.click()}>
              {capName || "Add captions"}
            </button>
            <button type="button" onClick={() => setFile(null)}>
              Use a link instead
            </button>
          </>
        ) : (
          <>
            <span>Or bring your own file.</span>
            <button type="button" onClick={() => fileRef.current?.click()}>
              Upload a video
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setFile(f);
          }}
        />
        <input ref={capRef} type="file" accept=".vtt,.srt" hidden onChange={(e) => setCapName(e.target.files?.[0]?.name ?? null)} />
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
