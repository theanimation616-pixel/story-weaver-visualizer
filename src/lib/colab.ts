/**
 * Remote encoder client (CPU box, VPS or GPU notebook).
 *
 * The user runs encoder_server.py on any machine with python3 + ffmpeg and
 * exposes it through a public https tunnel. This module posts the panel list to it, polls progress
 * and hands back a direct download URL for the finished mp4. Nothing is encoded
 * on the user's machine, so no WebCodecs / hardware-encoder support is needed.
 */

import type { Shot } from "@/lib/video";

export type ColabJob = { id: string; base: string };
export type ColabStatus = {
  state: "running" | "done" | "error";
  pct: number;
  note: string;
  download?: string;
  size?: number;
};

export function normalizeColabUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function headers(token?: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function colabHealth(
  url: string,
): Promise<{ ok: boolean; gpu: boolean; lanes: number }> {
  const res = await fetch(`${normalizeColabUrl(url)}/health`);
  if (!res.ok) throw new Error(`Encoder returned HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; gpu: boolean; lanes: number };
}

export async function startColabRender(
  url: string,
  shots: Shot[],
  targetSeconds: number,
  token?: string,
): Promise<ColabJob> {
  const base = normalizeColabUrl(url);
  const res = await fetch(`${base}/render`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      // The encoder pads/trims the last panel so the mp4 lands on this exact
      // runtime — the script's last timestamp, to the frame.
      target_seconds: targetSeconds,
      panels: shots.map((s) => ({
        url: s.url,
        start: s.start,
        end: s.end,
        prompt: s.prompt ?? "",
      })),
    }),
  });
  if (!res.ok) throw new Error(`Encoder rejected the job (HTTP ${res.status}).`);
  const { id } = (await res.json()) as { id: string };
  return { id, base };
}


export async function colabStatus(job: ColabJob): Promise<ColabStatus> {
  const res = await fetch(`${job.base}/status/${job.id}`);
  if (!res.ok) throw new Error(`Lost contact with the encoder (HTTP ${res.status}).`);
  return (await res.json()) as ColabStatus;
}

/** Runs a whole job to completion, reporting progress; resolves to a download URL. */
export async function renderOnColab(
  url: string,
  shots: Shot[],
  targetSeconds: number,
  onProgress: (pct: number, note: string) => void,
  token?: string,
): Promise<{ downloadUrl: string; size?: number }> {
  onProgress(1, "Sending panels to the encoder…");
  const job = await startColabRender(url, shots, targetSeconds, token);


  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let st: ColabStatus;
    try {
      st = await colabStatus(job);
      misses = 0;
    } catch (e) {
      // tunnels hiccup occasionally — tolerate a few misses
      if (++misses > 8) throw e;
      continue;
    }
    onProgress(Math.max(1, Math.min(99, st.pct)), st.note);
    if (st.state === "error") throw new Error(`Encoder: ${st.note}`);
    if (st.state === "done") {
      onProgress(100, "Video ready on the encoder");
      return { downloadUrl: `${job.base}${st.download}`, ...(st.size ? { size: st.size } : {}) };
    }
  }
}
