import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeScript,
  promptsForBatch,
  renderImage,
  renderBatch,
} from "@/lib/manga.functions";
import { buildTimeline, fmt, scriptEndTime, type Segment } from "@/lib/script";
import { buildVideo, webCodecsSupported } from "@/lib/video";
import { isBlankImageUrl } from "@/lib/blank";
import { loadRun, saveRun } from "@/lib/progress";
import { colabHealth, normalizeColabUrl, renderOnColab } from "@/lib/colab";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Script to Manga — AI Manga Video Generator" },
      {
        name: "description",
        content:
          "Turn a long timestamped script into thousands of consistent 16:9 manga panels and export a full-length video.",
      },
      { property: "og:title", content: "Script to Manga — AI Manga Video Generator" },
      {
        property: "og:description",
        content:
          "Paste a 100k-character script, get one manga panel per timestamp and a downloadable hours-long video.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Shot = Segment & {
  prompt?: string | undefined;
  url?: string | undefined;
  status: "waiting" | "prompting" | "drawing" | "done" | "error";
  error?: string | undefined;
};

const SAMPLE = `(0:00)Henan की कहानी असुरा का उदय. Henan नाम का एक साधारण लड़का था. (0:05)

वह Mumbai के एक पुराने building की छोटी सी किराए की कोठरी में रहता था. (0:09)

कमरा इतना छोटा था कि एक बिस्तर, एक छोटी अलमारी और एक खिड़की के अलावा कुछ जगह ही नहीं बचती थी. (0:16)`;

/* ------------------------------------------------------------------ */
/* Pipeline tuning                                                     */
/* ------------------------------------------------------------------ */

/** Script lines per analysed chunk — one image prompt is still written per line. */
const BATCH = 15;
/**
 * Chunks analysed + storyboarded at the same time: one per Paralon key, so the
 * 7 keys run 7 consecutive chunks in parallel, wave after wave in script order.
 */
const PROMPT_CONCURRENCY = 7;

/**
 * Parallel image request lanes. Each lane sends IMAGE_BATCH prompts in one
 * round trip and the server renders them concurrently, so the real number of
 * images in flight is IMAGE_CONCURRENCY * IMAGE_BATCH (measured: one Pixazo key
 * sustains 24 concurrent Flux Schnell renders with no rate limiting, so four
 * keys comfortably carry ~96). Auto-throttles if the provider pushes back.
 */
const IMAGE_CONCURRENCY = 24;
const IMAGE_BATCH = 4;
/** Panels shown in the preview grid before "show all" (a 2h script has 1000+). */
const PREVIEW_LIMIT = 60;

/* ------------------------------------------------------------------ */
/* Crash-safe progress                                                 */
/* ------------------------------------------------------------------ */

function scriptKey(script: string): string {
  let h = 0;
  for (let i = 0; i < script.length; i++) h = (Math.imul(31, h) + script.charCodeAt(i)) | 0;
  return `manga:${script.length}:${h}`;
}

type Saved = { bible: string; shots: Shot[] };

// Progress lives in IndexedDB (src/lib/progress.ts): a long script's shots +
// prompts overflow localStorage's ~5MB quota, which is what triggered the
// "exceed its storage quota" failure.
const loadSaved = (key: string) => loadRun<Shot>(key);
const saveProgress = (key: string, data: Saved) => saveRun(key, data);

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
}

function Index() {
  const analyze = useServerFn(analyzeScript);
  const getPrompts = useServerFn(promptsForBatch);
  const draw = useServerFn(renderImage);
  const drawBatch = useServerFn(renderBatch);

  const [script, setScript] = useState("");
  const [bible, setBible] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "video" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [videoPct, setVideoPct] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const [colabUrl, setColabUrlState] = useState("");
  const setColabUrl = useCallback((url: string) => {
    setColabUrlState(url);
    try {
      localStorage.setItem("sceneweaver.colabUrl", url);
    } catch {
      /* ignore */
    }
  }, []);
  const [colabInfo, setColabInfo] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<Shot[]>([]);
  const cancelRef = useRef(false);


  shotsRef.current = shots;

  // restore the Colab encoder link across refreshes
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sceneweaver.colabUrl");
      if (saved) setColabUrlState(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const doneCount = shots.filter((s) => s.status === "done").length;
  const failed = useMemo(() => shots.filter((s) => s.status === "error"), [shots]);
  const pct = shots.length ? Math.round((doneCount / shots.length) * 100) : 0;

  const stats = useMemo(() => {
    const words = script.trim() ? script.trim().split(/\s+/).length : 0;
    return { chars: script.length, words };
  }, [script]);

  // Runtime is the script's own span (first to last timestamp) — the exact
  // length the exported video is forced to match.
  const runtime = useMemo(() => scriptEndTime(script), [script]);


  // offer to resume whatever this exact script produced last time
  useEffect(() => {
    if (script.trim().length < 10) {
      setCanResume(false);
      return;
    }
    let alive = true;
    void loadSaved(scriptKey(script)).then((saved) => {
      if (alive) setCanResume(!!saved && saved.shots.length > 0 && shots.length === 0);
    });
    return () => {
      alive = false;
    };
  }, [script, shots.length]);

  const patch = useCallback((index: number, next: Partial<Shot>) => {
    setShots((prev) => prev.map((s) => (s.index === index ? { ...s, ...next } : s)));
  }, []);

  async function resume() {
    const saved = await loadSaved(scriptKey(script));
    if (!saved) return;
    setBible(saved.bible);
    setShots(saved.shots);
    setPhase("done");
    setNote(
      `Restored ${saved.shots.filter((s) => s.status === "done").length}/${saved.shots.length} panels from your last run.`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  async function run(existing?: Shot[], existingBible?: string) {
    setError(null);
    setVideoUrl(null);
    setSavedTo(null);
    cancelRef.current = false;
    setPhase("running");
    const key = scriptKey(script);

    try {
      let b = existingBible ?? "";
      let list: Shot[];

      if (existing && existing.length > 0) {
        list = existing;
      } else {
        setNote("Reading script and locking character designs…");
        const res = await analyze({ data: { script } });
        b = res.bible;
        list = res.segments.map((s) => ({ ...s, status: "waiting" as const }));
      }
      setBible(b);
      setShots(list);

      const pending = list.filter((s) => s.status !== "done" || !s.url);
      const total = list.length;

      // Stage 1: prompts for everything still missing one, in small parallel
      // batches. Stage 2 drains a shared queue as soon as prompts land, so
      // image rendering starts within seconds instead of after the last batch.
      const needPrompts = pending.filter((s) => !s.prompt);
      const batches: Segment[][] = [];
      for (let i = 0; i < needPrompts.length; i += BATCH)
        batches.push(needPrompts.slice(i, i + BATCH));

      let promptDone = total - needPrompts.length;
      let drawn = list.filter((s) => s.status === "done").length;
      let lastTick = 0;
      const tick = (force = false) => {
        const now = Date.now();
        if (!force && now - lastTick < 300) return;
        lastTick = now;
        setNote(`Prompts ${promptDone}/${total} · panels ${drawn}/${total}`);
      };
      tick(true);

      let keyTick = 0;
      const queue: { seg: Shot; prompt: string }[] = pending
        .filter((s) => s.prompt && !s.url)
        .map((s) => ({ seg: s, prompt: s.prompt as string }));

      let promptingDone = batches.length === 0;

      const record = (index: number, next: Partial<Shot>) => {
        list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
        patch(index, next);
      };

      let saveTimer = 0;
      const persist = () => {
        const now = Date.now();
        if (now - saveTimer < 4000) return;
        saveTimer = now;
        void saveProgress(key, { bible: b, shots: list });
      };

      // Chunk stage: PROMPT_CONCURRENCY consecutive chunks are analysed and
      // storyboarded in parallel (one API key each), wave after wave in script
      // order. Each wave hands the next wave the previous chunk briefs so the
      // story stays continuous across chunk boundaries.
      let carry = "";
      const runChunk = async (batch: Segment[], slot: number, ctx: string) => {
        if (cancelRef.current) return "";
        let brief = "";
        try {
          const res = await getPrompts({
            data: {
              bible: b,
              context: ctx,
              segments: batch.map((s) => ({
                index: s.index,
                start: s.start,
                end: s.end,
                text: s.text,
              })),
              slot,
            },
          });

          brief = ((res as { brief?: string }).brief ?? "").slice(0, 1200);
          const prompts = res.prompts as string[];
          batch.forEach((s, i) => {
            const prompt = prompts[i];
            if (!prompt) {
              record(s.index, { status: "error", error: "no prompt" });
              return;
            }
            record(s.index, { prompt, status: "waiting" });
            queue.push({ seg: s as Shot, prompt });
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          batch.forEach((s) => record(s.index, { status: "error", error: msg }));
        }
        promptDone += batch.length;
        tick();
        return brief;
      };

      // Last LOCATION seen in a chunk brief's BEATS block — carried forward so
      // the next chunk starts in the same place instead of drifting.
      const lastLocation = (brief: string): string => {
        const re = /^\s*\d+\s*[).:-]\s*LOCATION\s*:\s*([^|\n]+)/gim;
        let m: RegExpExecArray | null;
        let found = "";
        while ((m = re.exec(brief)) !== null) found = (m[1] ?? "").trim();
        return found.replace(/[.,;]+$/, "").slice(0, 80);
      };
      let carryLocation = "";

      const promptStage = (async () => {
        for (let w = 0; w < batches.length; w += PROMPT_CONCURRENCY) {
          if (cancelRef.current) break;
          const wave = batches.slice(w, w + PROMPT_CONCURRENCY);
          const ctxForWave = wave.map((batch) => {
            const first = batch[0]!.index;
            const lines = list
              .filter((s) => s.index >= first - 4 && s.index < first)
              .map((s) => `[${fmt(s.start)}] ${s.text}`)
              .join("\n");
            const loc = carryLocation
              ? `CURRENT LOCATION (the scene is still here — keep it unless a script line clearly moves it): ${carryLocation}`
              : "";
            return [loc, carry, lines].filter(Boolean).join("\n\n");
          });
          const briefs = await Promise.all(
            wave.map((batch, i) => runChunk(batch, keyTick++, ctxForWave[i] as string)),
          );
          const filled = briefs.filter(Boolean);
          carry = filled.slice(-2).join("\n\n").slice(0, 2500);
          for (const b2 of filled) {
            const loc = lastLocation(b2);
            if (loc) carryLocation = loc;
          }
        }
      })().then(() => {

        promptingDone = true;
      });


      // Adaptive throttle: back off globally when the provider rate-limits.
      let cooldownUntil = 0;

      const worker = async () => {
        for (;;) {
          if (cancelRef.current) return;
          const group = queue.splice(0, IMAGE_BATCH);
          if (group.length === 0) {
            if (promptingDone) return;
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          const wait = cooldownUntil - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));

          group.forEach((g) => record(g.seg.index, { status: "drawing" }));
          try {
            const { results } = await drawBatch({
              data: {
                bible: b,
                jobs: group.map((g) => ({
                  index: g.seg.index,
                  prompt: g.prompt,
                  seed: 1000 + g.seg.index,
                  slot: keyTick++,
                })),
              },
            });
            await Promise.all(
              results.map(async (r) => {
                if (r.url) {
                  // Pixel-level blank check in the browser: a flat/empty frame
                  // is re-rolled on a fresh seed and key so every timestamp
                  // ends up with a real image.
                  let url: string | null = r.url;
                  const prompt =
                    group.find((g) => g.seg.index === r.index)?.prompt ?? "";
                  for (let attempt = 1; attempt <= 2; attempt++) {
                    if (!url || !(await isBlankImageUrl(url))) break;
                    url = null;
                    if (!prompt) break;
                    try {
                      const res = await draw({
                        data: {
                          prompt,
                          seed: 1000 + r.index + attempt * 7919,
                          bible: b,
                          slot: keyTick++,
                        },
                      });
                      url = res.url;
                    } catch {
                      url = null;
                    }
                  }
                  if (url && !(await isBlankImageUrl(url))) {
                    record(r.index, { url, status: "done", error: undefined });
                  } else {
                    record(r.index, { status: "error", error: "blank image" });
                  }
                  return;
                }
                const msg = r.error ?? "render failed";
                if (/429|rate|quota/i.test(msg)) cooldownUntil = Date.now() + 5000;
                record(r.index, { status: "error", error: msg });
              }),
            );

          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/429|rate|quota/i.test(msg)) cooldownUntil = Date.now() + 5000;
            group.forEach((g) =>
              record(g.seg.index, { status: "error", prompt: g.prompt, error: msg }),
            );
          }
          drawn += group.length;
          tick();
          persist();
        }
      };

      await Promise.all([
        promptStage,
        ...Array.from({ length: IMAGE_CONCURRENCY }, () => worker()),
      ]);

      await saveProgress(key, { bible: b, shots: list });
      setPhase("done");
      const bad = list.filter((s) => !s.url).length;
      setNote(bad ? `${list.length - bad}/${list.length} panels ready · ${bad} failed` : "All panels generated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function retryFailed() {
    setPhase("running");
    const key = scriptKey(script);
    let keyTick = 0;
    let list = shotsRef.current;
    const record = (index: number, next: Partial<Shot>) => {
      list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
      patch(index, next);
    };
    const targets = shotsRef.current.filter((s) => !s.url);
    let n = 0;
    await pool(targets, IMAGE_CONCURRENCY, async (shot) => {
      record(shot.index, { status: "drawing" });
      try {
        let prompt = shot.prompt;
        if (!prompt) {
          const { prompts } = await getPrompts({
            data: {
              bible,
              segments: [{ index: shot.index, start: shot.start, end: shot.end, text: shot.text }],
              slot: keyTick++,
            },
          });
          prompt = prompts[0] as string;
        }
        const { url } = await draw({
          data: { prompt, seed: 7000 + shot.index, slot: keyTick++, bible },
        });
        record(shot.index, { url, prompt, status: "done", error: undefined });
      } catch (e) {
        record(shot.index, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      n++;
      setNote(`Retrying failed panels ${n}/${targets.length}`);
    });
    await saveProgress(key, { bible, shots: list });
    setPhase("done");
    setNote("Retry finished.");
  }

  /* ---------------------------------------------------------------- */
  /* Video                                                             */
  /* ---------------------------------------------------------------- */

  async function checkColab() {
    setError(null);
    setColabInfo(null);
    try {
      const h = await colabHealth(colabUrl);
      setColabInfo(
        h.gpu
          ? `Connected · GPU (NVENC) encoder ready · ${h.lanes} lanes`
          : `Connected · CPU encoder (libx264) ready · ${h.lanes} parallel lanes`,
      );

    } catch (e) {
      setError(
        `Could not reach that encoder. Make sure encoder_server.py is still running and the tunnel is up. (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
  }

  /** Encodes on the user's connected remote encoder — nothing runs on this device. */
  async function makeVideoOnColab() {
    setError(null);
    setSavedTo(null);
    setVideoUrl(null);
    setDownloadUrl(null);

    // Every script timestamp becomes a panel. Panels whose image failed reuse a
    // neighbour's image instead of vanishing, so the runtime always matches.
    const timeline = buildTimeline(shotsRef.current, scriptEndTime(script));

    if (timeline.panels.length === 0) {
      setError("No finished panels to build a video from.");
      return;
    }
    if (!colabUrl.trim()) {
      setError("Paste the https link of your remote encoder first.");
      return;
    }

    setPhase("video");
    setVideoPct(0);
    try {
      if (timeline.substituted > 0)
        setNote(
          `${timeline.substituted} panel(s) had no image — covering their time with the nearest panel so the length still matches the script.`,
        );
      const res = await renderOnColab(colabUrl, timeline.panels, timeline.total, (p, n) => {
        setVideoPct(p);
        setNote(n);
      });
      setDownloadUrl(res.downloadUrl);
      setNote(`Video ready (${fmt(timeline.total)}) — download it from the encoder`);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function makeVideo() {
    setError(null);
    setSavedTo(null);
    setVideoUrl(null);
    setDownloadUrl(null);

    const timeline = buildTimeline(shotsRef.current, scriptEndTime(script));
    const ready = timeline.panels;

    if (ready.length === 0) {
      setError("No finished panels to build a video from.");
      return;
    }
    if (!webCodecsSupported()) {
      setError(
        "This browser has no video encoder. Either open the page in the latest desktop Chrome/Edge, or encode on your remote CPU/GPU server instead.",
      );
      return;
    }

    const seconds = timeline.total;
    const long = seconds > 600; // 10 min+ must stream to disk, not to RAM


    let handle: FileSystemFileHandle | undefined;
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;

    if (picker) {
      try {
        handle = await picker({
          suggestedName: "manga-video.mp4",
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
        });
      } catch {
        if (long) {
          setError("A video this long must be saved to a file. Pick a save location and try again.");
          return;
        }
      }
    } else if (long) {
      setError(
        "This browser cannot stream a multi-hour video to disk. Use desktop Chrome or Edge so the file can be written directly.",
      );
      return;
    }

    setPhase("video");
    setVideoPct(0);
    try {
      const res = await buildVideo(
        ready,
        (p: number, n: string) => {
          setVideoPct(p);
          setNote(n);
        },
        { fileHandle: handle, targetSeconds: timeline.total },
      );

      if (res.kind === "file") {
        setSavedTo(res.fileName);
        setNote(`Saved ${res.fileName}`);
      } else {
        setVideoUrl(URL.createObjectURL(res.blob));
      }
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then(setScript);
  }

  const busy = phase === "running" || phase === "video";
  const visible = showAll ? shots : shots.slice(0, PREVIEW_LIMIT);

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-4 border-foreground pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.4em] text-accent-foreground">
            AI Manga Studio
          </p>
          <h1 className="mt-2 font-display text-5xl font-black uppercase leading-none tracking-tight">
            Script → Manga Video
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Paste a timestamped script — including full-length ones of 100,000+ characters. Every{" "}
            <span className="font-semibold">(m:ss)</span> window becomes one fixed-style 16:9 manga
            panel with locked character identities, then everything is encoded into a single
            downloadable video.
          </p>
        </header>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="font-display text-lg font-bold uppercase">Your script</label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {stats.chars.toLocaleString()} chars · {stats.words.toLocaleString()} words
              </span>
              <button
                onClick={() => setScript(SAMPLE)}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Sample
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Upload .txt
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                onChange={onFile}
                className="hidden"
              />
            </div>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder="(0:00)पहली लाइन... (0:05)&#10;&#10;दूसरी लाइन... (0:09)"
            className="mt-3 w-full resize-y border-2 border-foreground bg-card p-4 font-mono text-sm outline-none focus:ring-4 focus:ring-ring"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              disabled={busy || script.trim().length < 10}
              onClick={() => run()}
              className="border-4 border-foreground bg-primary px-6 py-3 font-display text-lg font-black uppercase text-primary-foreground shadow-[6px_6px_0_0_var(--color-foreground)] transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[3px_3px_0_0_var(--color-foreground)] disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate manga"}
            </button>
            {canResume && !busy && (
              <button
                onClick={resume}
                className="border-4 border-foreground bg-secondary px-6 py-3 font-display text-lg font-black uppercase text-secondary-foreground"
              >
                Resume last run
              </button>
            )}
            {failed.length > 0 && !busy && (
              <button
                onClick={retryFailed}
                className="border-4 border-foreground bg-destructive px-6 py-3 font-display text-lg font-black uppercase text-destructive-foreground"
              >
                Retry {failed.length} failed
              </button>
            )}
            {doneCount > 0 && !busy && (
              <>
                <button
                  onClick={makeVideoOnColab}
                  className="border-4 border-foreground bg-accent px-6 py-3 font-display text-lg font-black uppercase text-accent-foreground"
                >
                  Encode on server
                </button>
                <button
                  onClick={makeVideo}
                  className="border-4 border-foreground bg-secondary px-6 py-3 font-display text-lg font-black uppercase text-secondary-foreground"
                >
                  Build in browser
                </button>
              </>
            )}

            {busy && (
              <button
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="border-4 border-foreground px-6 py-3 font-display text-lg font-black uppercase"
              >
                Stop
              </button>
            )}
          </div>
        </section>

        {(shots.length > 0 || busy) && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <div className="flex items-center justify-between gap-4 font-mono text-xs uppercase">
              <span className="truncate">{note || "Ready"}</span>
              <span className="shrink-0">
                {doneCount}/{shots.length} panels ·{" "}
                {runtime ? `${Math.floor(runtime / 60)}m runtime` : "—"}
              </span>
            </div>
            <div className="mt-3 h-4 w-full border-2 border-foreground">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${phase === "video" ? videoPct : pct}%` }}
              />
            </div>
            {bible && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-display font-bold uppercase">
                  Character consistency sheet (text only — never drawn)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {bible}
                </pre>
              </details>
            )}
          </section>
        )}

        <section className="mt-8 border-4 border-foreground bg-card p-5">
          <h2 className="font-display text-2xl font-black uppercase">Remote encoder (CPU or GPU)</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Encode the final video on any remote machine — a plain <strong>CPU</strong> cloud box or
            a GPU runtime. Nothing is rendered locally, so multi-hour exports never hit your
            browser's encoder or storage quota. The server auto-detects NVENC and falls back to
            libx264, saturating every core it finds.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              On your CPU box (needs <span className="font-mono">python3</span> +{" "}
              <span className="font-mono">ffmpeg</span>){" "}
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await fetch("/colab/encoder_server.py");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "encoder_server.py";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 2000);
                  } catch {
                    window.open("/colab/encoder_server.py", "_blank");
                  }
                }}
                className="font-semibold underline"
              >
                download encoder_server.py
              </button>{" "}
              and run <span className="font-mono">python3 encoder_server.py</span> (listens on port
              8000).
            </li>
            <li>
              Expose it over https, e.g.{" "}
              <span className="font-mono">cloudflared tunnel --url http://localhost:8000</span>.
            </li>
            <li>Paste that https link below and hit Connect.</li>
            <li className="text-muted-foreground">
              On a GPU notebook instead? Use the{" "}
              <button
                type="button"
                onClick={() => window.open("/colab/scene-weaver-gpu-encoder.ipynb", "_blank")}
                className="font-semibold underline"
              >
                notebook version
              </button>
              .
            </li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              value={colabUrl}
              onChange={(e) => setColabUrl(normalizeColabUrl(e.target.value))}
              placeholder="https://something.trycloudflare.com"
              className="min-w-[280px] flex-1 border-2 border-foreground bg-background p-3 font-mono text-sm outline-none focus:ring-4 focus:ring-ring"
            />
            <button
              onClick={checkColab}
              className="border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Connect
            </button>
          </div>
          {colabInfo && <p className="mt-3 font-mono text-xs uppercase">{colabInfo}</p>}
        </section>


        {error && (
          <p className="mt-4 border-2 border-destructive bg-destructive/10 p-3 text-sm">{error}</p>
        )}

        {savedTo && (
          <p className="mt-4 border-2 border-foreground bg-card p-3 text-sm">
            Video written to <span className="font-mono font-bold">{savedTo}</span>.
          </p>
        )}

        {videoUrl && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <h2 className="font-display text-2xl font-black uppercase">Your video</h2>
            <video src={videoUrl} controls className="mt-3 w-full border-2 border-foreground" />
            <a
              href={videoUrl}
              download="manga-video.mp4"
              className="mt-3 inline-block border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
            Download mp4
            </a>
          </section>
        )}

        {downloadUrl && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <h2 className="font-display text-2xl font-black uppercase">Your video (remote encoder)</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Encoded on your remote server. Download it while the server and tunnel are still
              running — the link dies with the session.
            </p>
            <video src={downloadUrl} controls className="mt-3 w-full border-2 border-foreground" />
            <a
              href={downloadUrl}
              download="manga-video.mp4"
              className="mt-3 inline-block border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Download mp4
            </a>
          </section>
        )}

        {shots.length > 0 && (
          <>
            <section className="mt-8 grid gap-5 sm:grid-cols-2">
              {visible.map((s) => (
                <article key={s.index} className="border-4 border-foreground bg-card">
                  <div className="flex items-center justify-between border-b-2 border-foreground px-3 py-2 font-mono text-xs uppercase">
                    <span>
                      #{s.index + 1} · {fmt(s.start)} → {fmt(s.end)}
                    </span>
                    <span
                      className={s.status === "error" ? "text-destructive" : "text-muted-foreground"}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="aspect-video w-full bg-muted">
                    {s.url ? (
                      <img
                        src={s.url}
                        alt={`Manga panel ${s.index + 1}`}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center font-mono text-xs text-muted-foreground">
                        {s.status === "error" ? "failed" : "…"}
                      </div>
                    )}
                  </div>
                  <p className="border-t-2 border-foreground p-3 text-xs text-muted-foreground">
                    {s.text}
                  </p>
                </article>
              ))}
            </section>
            {shots.length > PREVIEW_LIMIT && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-6 border-2 border-foreground px-4 py-2 font-display text-sm font-bold uppercase"
              >
                {showAll
                  ? "Show first 60 panels"
                  : `Show all ${shots.length.toLocaleString()} panels`}
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
