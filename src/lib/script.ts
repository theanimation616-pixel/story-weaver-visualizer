export type Segment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

// The first field is intentionally unbounded: long scripts commonly continue
// MM:SS past 99 minutes (for example 120:19), as well as using HH:MM:SS.
// Brackets are optional and may be any common style — (0:05), [0:05], 【0:05】,
// or a bare 0:05 at the start of a line — so real-world scripts all parse.
const TS =
  /[(\[{（【]\s*(\d+):(\d{2})(?::(\d{2}))?\s*[)\]}）】]|(?:^|[\s—–-])(\d+):(\d{2})(?::(\d{2}))?(?=\s|$)/gm;


/** Timeline frame rate. Every duration is quantised to this grid so the encoder
 * cannot drift: round(dur * FPS) is then always exact. */
export const FPS = 30;
/** Shortest panel the encoders accept. Shorter spans are merged, never dropped. */
export const MIN_PANEL = 0.8;

export function quantise(t: number): number {
  return Math.round(t * FPS) / FPS;
}

function toSeconds(m: RegExpExecArray): number {
  const bracketed = m[1] !== undefined;
  const a = Number(bracketed ? m[1] : m[4]);
  const b = Number(bracketed ? m[2] : m[5]);
  const third = bracketed ? m[3] : m[6];
  const c = third !== undefined ? Number(third) : null;
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}


/**
 * Absolute final timestamp in the raw script. This is the authoritative video
 * runtime and deliberately does not depend on how many panels were generated.
 */
export function scriptEndTime(raw: string): number {
  TS.lastIndex = 0;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = TS.exec(raw)) !== null) {
    const seconds = toSeconds(m);
    if (Number.isFinite(seconds)) end = Math.max(end, seconds);
  }
  return quantise(end);
}

/**
 * Parses a script of the form:
 *   (0:00)text... (0:05)
 *   more text (0:09)
 *
 * Every timestamp marks a boundary; the text between two boundaries is one
 * segment. Segments are strictly contiguous — one segment's `end` is always the
 * next segment's `start` — so the sum of all segment durations equals
 * (last timestamp − first timestamp) exactly. Nothing is ever dropped: a
 * boundary pair with no text is merged into the previous segment so its time
 * still belongs to the timeline.
 */
export function parseScript(raw: string): Segment[] {
  const marks: { at: number; time: number; len: number }[] = [];
  TS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TS.exec(raw)) !== null) {
    const time = toSeconds(m);
    const prev = marks[marks.length - 1];
    // Non-increasing timestamps would break contiguity — keep the monotonic run.
    if (prev && time <= prev.time) continue;
    // A bare timestamp match may include the separator that preceded it; keep
    // that character with the previous segment's text.
    const lead = m[1] === undefined && /^[\s—–-]/.test(m[0]) ? 1 : 0;
    marks.push({ at: m.index + lead, time, len: m[0].length - lead });
  }
  if (marks.length === 0) return [];

  type Raw = { start: number; end: number; text: string };
  const rawSegs: Raw[] = [];

  const push = (start: number, end: number, text: string) => {
    if (end <= start) return;
    if (!text) {
      // No dialogue in this span. One timestamp = one panel, so it still gets
      // its OWN image: a continuation beat of the previous line. Only a span
      // too short to render is folded into the previous panel (its time is
      // never dropped, so the video can't come out shorter than the script).
      const last = rawSegs[rawSegs.length - 1];
      if (end - start < MIN_PANEL && last) {
        last.end = end;
        return;
      }
      if (last) {
        rawSegs.push({
          start,
          end,
          text: `Continuation of the same moment, camera holds on the scene: ${last.text}`,
        });
        return;
      }
      // leading gap before the first spoken line — keep it as an establishing beat
      rawSegs.push({ start, end, text: "Establishing shot of the story's opening setting." });
      return;
    }
    rawSegs.push({ start, end, text });
  };


  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!;
    const b = marks[i + 1]!;
    const text = raw.slice(a.at + a.len, b.at).replace(/\s+/g, " ").trim();
    push(a.time, b.time, text);
  }

  // Trailing text after the last timestamp (script may end without a closing mark)
  const last = marks[marks.length - 1]!;
  const tail = raw.slice(last.at + last.len).replace(/\s+/g, " ").trim();
  if (tail) {
    const words = tail.split(" ").length;
    const dur = Math.max(4, Math.min(12, Math.round(words / 2.5)));
    push(last.time, last.time + dur, tail);
  }

  // Merge spans shorter than one panel into their neighbour so every segment is
  // renderable while the overall span stays identical.
  const merged: Raw[] = [];
  for (const s of rawSegs) {
    const prev = merged[merged.length - 1];
    if (prev && s.end - s.start < MIN_PANEL) {
      prev.end = s.end;
      prev.text = `${prev.text} ${s.text}`.trim();
      continue;
    }
    merged.push({ ...s });
  }
  if (merged.length > 1 && merged[0]!.end - merged[0]!.start < MIN_PANEL) {
    const first = merged.shift()!;
    merged[0]!.start = first.start;
    merged[0]!.text = `${first.text} ${merged[0]!.text}`.trim();
  }

  return merged.map((s, i) => ({
    index: i,
    start: quantise(s.start),
    end: quantise(s.end),
    text: s.text,
  }));
}

/** Total runtime the finished video MUST have: last timestamp − first timestamp. */
export function scriptDuration(segments: { start: number; end: number }[]): number {
  if (segments.length === 0) return 0;
  const start = segments.reduce((m, s) => Math.min(m, s.start), segments[0]!.start);
  const end = segments.reduce((m, s) => Math.max(m, s.end), segments[0]!.end);
  return quantise(end - start);
}

export function fmt(t: number): string {
  const total = Math.max(0, Math.round(t));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export type PanelSource = {
  start: number;
  end: number;
  url?: string | undefined;
  prompt?: string | undefined;
};

export type Panel = { url: string; start: number; end: number; prompt?: string | undefined };

export type Timeline = {
  panels: Panel[];
  /** Exact runtime of the panel list — always equal to the script duration. */
  total: number;
  /** Panels whose own image was missing and reuse a neighbour's image. */
  substituted: number;
};

/**
 * Builds the video timeline from the generated shots.
 *
 * Contract (this is what keeps the video the same length as the script):
 *  1. Panels are strictly contiguous — no gaps, no overlaps.
 *  2. A shot whose image failed NEVER removes its time from the timeline; the
 *     nearest available image is shown across it instead, so a 1:55:04 script
 *     always exports as a 1:55:04 video.
 *  3. Every boundary is frame-aligned and every panel is at least MIN_PANEL
 *     long, so the encoders' round(dur * FPS) can't accumulate drift.
 */
export function buildTimeline(shots: PanelSource[], targetSeconds?: number): Timeline {
  const all = [...shots]
    .map((s) => ({ ...s, start: quantise(s.start), end: quantise(s.end) }))
    .sort((a, b) => a.start - b.start);
  if (all.length === 0) return { panels: [], total: 0, substituted: 0 };
  if (!all.some((s) => s.url)) return { panels: [], total: 0, substituted: 0 };

  // Video time starts at zero and ends at the raw script's last timestamp.
  // A target can therefore extend beyond incomplete/restored panel data without
  // losing the missing tail; the nearest available image simply holds over it.
  const t0 = 0;
  const panelEnd = all.reduce((m, s) => Math.max(m, s.end), all[0]!.end);
  // When the raw script supplied an explicit final timestamp it is absolute,
  // not a minimum. parseScript may give trailing text a provisional duration
  // so it can still generate its image, but that must never extend the video.
  const tEnd = quantise(targetSeconds === undefined ? panelEnd : targetSeconds);

  // 1. contiguous boundaries from the timestamps themselves
  const bounds: number[] = [];
  for (let i = 0; i < all.length; i++)
    bounds.push(i === 0 ? t0 : Math.min(tEnd, all[i]!.start));
  bounds.push(tEnd);

  // 2. resolve every panel's image: its own, else the nearest neighbour's
  let substituted = 0;
  const resolved: { url: string; prompt?: string | undefined }[] = [];
  for (let i = 0; i < all.length; i++) {
    const own = all[i]!;
    if (own.url) {
      resolved.push({ url: own.url, prompt: own.prompt });
      continue;
    }
    let pick: PanelSource | undefined;
    for (let b = i - 1; b >= 0; b--)
      if (all[b]!.url) {
        pick = all[b]!;
        break;
      }
    if (!pick)
      for (let f = i + 1; f < all.length; f++)
        if (all[f]!.url) {
          pick = all[f]!;
          break;
        }
    substituted++;
    resolved.push({ url: pick!.url as string, prompt: pick!.prompt });
  }

  // 3. lay them out, merging anything under MIN_PANEL forward
  const panels: Panel[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const prev = panels[panels.length - 1];
    if (end - start < MIN_PANEL && prev) {
      prev.end = end;
      continue;
    }
    panels.push({ url: resolved[i]!.url, start, end, prompt: resolved[i]!.prompt });
  }
  if (panels.length > 1 && panels[0]!.end - panels[0]!.start < MIN_PANEL) {
    const first = panels.shift()!;
    panels[0]!.start = first.start;
  }
  if (panels.length === 0) return { panels: [], total: 0, substituted };

  // 4. hard guarantee: first panel starts at t0, last ends at tEnd
  panels[0]!.start = t0;
  panels[panels.length - 1]!.end = tEnd;

  return { panels, total: quantise(tEnd - t0), substituted };
}

/** Sum of the panel durations exactly as the encoders will render them. */
export function timelineSeconds(panels: Panel[]): number {
  return quantise(panels.reduce((a, p) => a + Math.max(MIN_PANEL, p.end - p.start), 0));
}
