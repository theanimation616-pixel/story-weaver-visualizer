import type { Segment } from "./script";
import { paralonKeys, pixazoKeys, pickKey } from "./keys.server";

const CHAT_URL = "https://paraloncloud.com/v1/chat/completions";
/** Free-tier model only — the Paralon keys carry no credits. */
const CHAT_MODEL = "qwen3.8-27b";
const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";

/**
 * Global art direction: look and craft only. The tone is stated ONCE, in
 * TONE_LOCK below — stacking it here as well is what used to compound into
 * near-black panels.
 */
export const STYLE =
  "cinematic anime manga illustration, moody atmospheric key visual, " +
  "restrained palette of charcoal, midnight blue, cold slate grey and warm ember accents, " +
  "cel shading with soft gradients, bold clean ink lines, richly detailed painted backgrounds, " +
  "clear focal subject, crisp facial features, high quality anime key visual";

/** The single authoritative tone statement for every panel. */
export const TONE_LOCK =
  "TONE: moody low-key cinematic lighting, dim and mysterious, with the subject, faces and key details clearly lit " +
  "and easy to read; shadows keep detail and midtones stay visible";


/** @deprecated kept as an alias so older call sites keep compiling. */
export const DARK_TONE_LOCK = TONE_LOCK;



/**
 * Flux has NO negative prompt: every noun written here is a token the model can
 * draw. Long "no speech bubbles, no posters, no billboards..." lists were being
 * rendered literally (walls of speech bubbles and signage). So the guards are
 * now short and phrased POSITIVELY wherever possible.
 */
export const NO_TEXT_GUARD = "completely free of any text, lettering or signage";

/** Single-image guard. Deliberately short; see NO_TEXT_GUARD note above. */
export const SINGLE_PANEL_GUARD =
  "one single full-bleed illustration of this one moment, one continuous scene, fully drawn and detailed";

/** Added only when the scene has no people in it. */
export const NO_PEOPLE_GUARD =
  "an empty environment shot with no people, no figures and no characters anywhere in frame";

/** Added only when the scene does have named/described people. */
export const CAST_GUARD =
  "only the people described above are present, each drawn once, each with the exact gender stated for them, male characters unmistakably male and female characters unmistakably female, never swapped or blended";


export async function zaiChat(
  messages: { role: string; content: string }[],
  opts: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    attempts?: number;
    /** Scene/batch index — spreads concurrent calls over the key pool. */
    slot?: number;
  } = {},
): Promise<string> {
  const keys = paralonKeys();
  const slot = opts.slot ?? 0;

  const attempts = opts.attempts ?? 3;
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Free model only: the keys hold zero credits, so never fall back
          // to a paid model.
          model: opts.model ?? CHAT_MODEL,
          temperature: opts.temperature ?? 0.6,
          // Disable Qwen3 thinking/reasoning mode so the model answers directly
          // and returns much faster. vLLM reads it from chat_template_kwargs;
          // the flat flag is kept for gateways that look at the top level.
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: opts.maxTokens ?? 4000,
          messages,
        }),
      });
      if (!res.ok) {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        // 401/403 = bad key, 400 = the request itself (usually too long) — both
        // are pointless to retry on the same payload.
        if (res.status === 400 || res.status === 401 || res.status === 403) break;
        // free tier is 60 req/min per key: wait out the window on another key
        if (res.status === 429 && attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
          continue;
        }
      } else {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning?: string } }[];
        };
        const msg = json.choices?.[0]?.message;
        const text = msg?.content?.trim() || extractFromReasoning(msg?.reasoning);
        if (text) return text;
        lastErr = "empty completion";
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // 502/504 come from the provider's edge (HTML body), not the model:
    // back off progressively instead of failing the whole batch.
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  throw new Error(`Text model request failed: ${lastErr}`);
}

/** Last-resort salvage: pull a JSON array out of truncated reasoning text. */
function extractFromReasoning(reasoning?: string): string | null {
  if (!reasoning) return null;
  const start = reasoning.indexOf("[");
  const end = reasoning.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const slice = reasoning.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return Array.isArray(parsed) ? slice : null;
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

export function parseJsonArray(raw: string): unknown[] {
  const text = stripFences(raw);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Model did not return a JSON array");
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are a manga art director for a DARK, mysterious, noir-toned anime film. Read the script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 14-25 words per character. Max 6 characters. " +
    "You are given only the OPENING of the script; that is enough — do not ask for more. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary. Do not deliberate — answer immediately.";

  // head-only sample, cut on a line boundary so the model never sees half a word
  const sampleAt = (budget: number) => {
    if (script.length <= budget) return script;
    const head = script.slice(0, budget);
    const cut = head.lastIndexOf("\n");
    return cut > budget * 0.5 ? head.slice(0, cut) : head;
  };

  let lastErr = "";
  // shrink on every failure: context overflow is the usual cause for long scripts
  for (const [i, budget] of [6000, 4000, 2500, 1200].entries()) {
    try {
      const out = await zaiChat(
        [
          { role: "system", content: system },
          { role: "user", content: `SCRIPT OPENING:\n${sampleAt(budget)}` },
        ],
        { maxTokens: 1200, timeoutMs: 90_000, attempts: 2, slot: i },
      );
      const bible = stripFences(out).slice(0, 2400);
      if (bible.length > 20) return bible;
      lastErr = "empty bible";

    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("buildCharacterBible failed, continuing without a bible:", lastErr);
  return "";
}


const PROMPT_SYSTEM =
  "You write image prompts for a DARK, mysterious, cinematic manga storyboard. Input: a character bible, optional story " +
  "context, and numbered script lines (Hindi/Hinglish). For EACH numbered line write ONE English image prompt describing a " +
  "SINGLE cinematic moment from that line.\n" +
  "EVERY prompt must contain, in this order: (1) who is in frame with their bible traits woven inline — but ONLY if the " +
  "script line actually mentions a person; if it mentions none, this part is skipped entirely and the shot has no people " +
  "at all, (2) the exact action and facial expression, (3) the specific setting with 2-3 concrete environmental details " +
  "taken from the script line, (4) the camera angle and shot size (extreme close-up / close-up / medium / wide / low " +
  "angle / over-the-shoulder / Dutch tilt), (5) the lighting description (e.g. 'single bare bulb throwing hard shadows', " +
  "'blue moonlight through a barred window', 'dull ember glow in thick darkness').\n" +

  "RULES:\n" +
  "- ONE LINE = ONE IMAGE (absolute): the output array has EXACTLY one prompt per numbered line, in the same order, even " +
  "when consecutive lines are similar. Never merge two lines, never split one line into two, never skip a line, never " +
  "return a placeholder. Each prompt must be visibly DIFFERENT from its neighbours (different action, framing or " +
  "expression) because each one becomes its own image.\n" +
  "- SCRIPT ACCURACY (absolute): the prompt must be a literal visual translation of THAT line's content — the exact " +
  "subject, action, object, place, gesture, emotion, weather and time of day the line states. If the line states a " +
  "detail that can be drawn, it must appear in the prompt. Add nothing the line and brief do not support: no invented " +
  "props, events, people, animals or settings. If a line is inner thought or narration, draw the concrete thing it " +
  "talks about (the person, place or object) in the beat's LOCATION, not a symbolic or unrelated image.\n" +
  "- CHUNK + TIMESTAMP (critical): each prompt is written for ONE numbered timestamp, but grounded in the CHUNK BRIEF. " +
  "Take the place, lighting, objects and cast from the brief's SETTING/OBJECTS/MOOD/CAST, then apply the per-line BEAT " +
  "and the exact words of that timestamp's line. A prompt must never contradict the brief, and must never copy another " +
  "timestamp's action.\n" +

  "- LOCATION LOCK (critical): every BEAT line starts with 'LOCATION: <place>'. The prompt for that numbered line MUST " +
  "OPEN with that exact place, worded the same way (e.g. 'In the damp stone dungeon cell, ...'), and the rest of the " +
  "prompt must stay inside it. You are FORBIDDEN from inventing, substituting or drifting to any other place — no city " +
  "street, market, jungle, forest, school, office or rooftop unless that is the beat's own LOCATION. Dialogue, " +
  "whispers ('फुसफुसाया'), shouts, reactions, memories and thoughts NEVER move the scene: keep the beat's LOCATION " +
  "and change only the camera, expression and framing. Only a beat whose own LOCATION differs may show a new place.\n" +

  "- FAITHFUL DETAIL (critical): the prompt must capture the specific things that line actually says — the object, the " +
  "place, the gesture, the emotion, the weather, the time of day. Never write a generic 'a boy stands thinking' prompt. " +
  "Do not skip story details; if the line has several details, include the most visual ones.\n" +
  "- TONE: moody low-key and mysterious — night, dusk, storm, dim interiors, motivated single light sources — but the " +
  "subject must be clearly lit and readable: name a key light that lands on the character's face. Avoid flat bright " +
  "sunny daylight and white backgrounds; a daytime line can be overcast or softly lit rather than pitch dark.\n" +

  "- Weave a character's fixed traits INLINE into the sentence (e.g. 'Henan, a thin 17-year-old boy with messy jet-black " +
  "hair, sits...'). NEVER write a separate character description block, character sheet, reference, lineup, or 'plus portrait of'.\n" +
  "- CONSISTENCY: repeat a character's bible traits (hair, eyes, clothing colours) in EVERY prompt they appear in, using " +
  "the same words as the bible. Never redesign, re-age or re-dress a character between shots.\n" +
  "- GENDER ACCURACY (critical): every main character from the bible MUST be written with their name AND their exact " +
  "gender from the bible, using an explicit gendered noun — e.g. 'Henan, a male 17-year-old boy...' or 'Priya, a female " +
  "14-year-old girl...'. Never refer to a main character as just 'a man', 'a woman', 'a person', 'he' or 'she' without the " +
  "name. NEVER change, swap or reverse any character's gender. For side characters not in the bible, pick one gender from " +
  "the script context and state it explicitly (e.g. 'a female boss in her 40s, dark business suit').\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): when a prompt shows more than one character, name each one separately with " +
  "their gender and their own distinct traits, and say where each stands (e.g. 'Henan, a male 17-year-old boy with messy " +
  "jet-black hair, on the left, facing Priya, a female 14-year-old girl with a long braid, on the right'). Never write a " +
  "shared description like 'two figures' or 'the two of them', never let one character's hair, clothing or body type bleed " +
  "onto the other, and never render a male character with feminine features or a female character with masculine features.\n" +

  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets, collages or " +
  "side-by-side views.\n" +
  "- WHO LOCK (critical): every BEAT line contains 'WHO: <names>'. That list is the ONLY cast allowed in that prompt — " +
  "no one else may appear, not even the main character. If WHO says 'no people', the prompt MUST be a pure environment " +
  "shot with nobody, no silhouette and no distant figure. If WHO names a side character, draw THAT side character (with " +
  "their look from the brief's CAST), never the protagonist.\n" +
  "- PRONOUNS (critical): Hindi pronouns (वो, वह, उसने, उसके, उसकी, इसने, उन्होंने) refer to whoever the BEAT's WHO " +
  "names — resolve them through the WHO list, never default to the main character. If the previous line was about a " +
  "side character, 'उसने' is that side character.\n" +
  "- CAST FIDELITY: include ONLY the people in WHO, each drawn once. Never assume two characters are together unless " +
  "WHO lists both.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "names NO person by name or pronoun, the prompt MUST be a pure environment shot with NOBODY in it. Start it with " +
  "'Empty environment shot, no people:' and describe only the place/object/phenomenon, its scale, atmosphere and " +
  "lighting. Never add a silhouette, a lone figure, an onlooker or the main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd, people running or panicking, then the prompt MUST show " +
  "that crowd (many varied ordinary people, their expressions and motion) — do not reduce it to one person.\n" +
  "- SIDE CHARACTERS: if WHO names someone NOT in the bible (a boss, teacher, shopkeeper), use the short distinct " +
  "visual the brief's CAST gives them (age, gender, one clothing detail). NEVER substitute a main character's name or " +
  "traits for a side character.\n" +
  "- STRICT FIDELITY: describe ONLY what the script line actually says. Never invent people, animals, vehicles or crowds " +
  "the line does not mention. If the line names no location, keep the background a simple dark neutral space.\n" +


  "- NO TEXT: never describe text, letters, words, numbers, signs, signboards, posters, banners, newspapers, book pages, " +
  "screens with writing, labels or logos. If the script mentions something written, show the OBJECT and the character's " +
  "reaction instead, never the writing itself.\n" +
  "- 55 to 85 words each. English only. No numbering inside the string.\n" +
  "- Do not deliberate or explain. Output the JSON array immediately.\n" +
  'Return ONLY a JSON array of strings, one per numbered line, in order.';

const CHUNK_SYSTEM =
  "You are a manga art director. You are given a character bible, the story so far, and one CHUNK of consecutive " +
  "script lines (Hindi/Hinglish) with timestamps. Analyse ONLY this chunk and return a compact English CHUNK BRIEF " +
  "that a storyboard artist will use to draw every line of this chunk.\n" +
  "Return plain text with exactly these labelled lines:\n" +
  "SETTING: the place(s) this chunk happens in, with 3-5 concrete visual details (architecture, objects, weather, time of day).\n" +
  "CAST: only the people who actually appear in this chunk, each with their fixed traits (from the bible if listed there, " +
  "otherwise invent a short fixed look: age, gender, hair, clothing colour). ALWAYS state each person's gender " +
  "explicitly as 'male' or 'female' with a matching noun, identical every time that person appears in the story. " +
  "Write 'none' if the chunk has no people.\n" +
  "OBJECTS: the specific things/phenomena the chunk mentions (gates, storm, letter, vehicle...) and how they look.\n" +
  "MOOD: lighting and atmosphere for this chunk (one line).\n" +
  "BEATS: one short line per numbered script line, in this exact format — 'n) LOCATION: <the place this shot happens " +
  "in, 3-6 words> | WHO: <exact character names visible in this shot, comma separated, or 'no people'> | <what visibly " +
  "happens>'.\n" +
  "LOCATION rules: it must stay the SAME for every line of the chunk unless the script line itself clearly moves the " +
  "scene somewhere else (a stated new place, a door opened, a journey). Dialogue, whispering, reactions and thoughts " +
  "NEVER change the location.\n" +
  "WHO rules (critical): resolve every Hindi pronoun (वो, वह, उसने, उसके, उसकी, इसने, उन्होंने, वे) to the ACTUAL " +
  "character it refers to by reading the surrounding lines of this chunk and the story so far — it is very often a SIDE " +
  "character, not the protagonist. Never write the protagonist's name unless that line truly shows him. Write the " +
  "resolved names only (e.g. 'WHO: Marie' or 'WHO: Marie, the team captain'). If the line names no person by noun and " +
  "no pronoun refers to a person — a place, sky, object, weather, phenomenon or narration about the world — write " +
  "exactly 'WHO: no people'. For unnamed masses write 'WHO: crowd'. Do NOT add any human to a line that has none.\n" +
  "GENDER rule (critical): after each name in WHO, add its gender in brackets, e.g. 'WHO: Henan (male), Priya (female)'. " +
  "Use the bible/CAST gender and keep it identical for that character in every beat of every chunk.\n" +
  "Be specific and faithful to the script. No commentary, no headings other than the labels above. Answer immediately.";



/**
 * Reads one chunk of the script and returns a brief (setting, cast present,
 * objects, mood, per-line beats). Written before the chunk's prompts so every
 * panel in the chunk shares the same analysed context — this is what keeps
 * detail and continuity inside a chunk.
 */
export async function analyzeChunk(
  bible: string,
  segments: Segment[],
  slot = 0,
  context = "",
): Promise<string> {
  const numbered = segments.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
  try {
    const out = await zaiChat(
      [
        { role: "system", content: CHUNK_SYSTEM },
        {
          role: "user",
          content:
            `CHARACTER BIBLE:\n${bible}\n\n` +
            (context ? `STORY SO FAR:\n${context}\n\n` : "") +
            `CHUNK SCRIPT LINES:\n${numbered}`,
        },
      ],
      {
        temperature: 0.4,
        maxTokens: 500 + segments.length * 100,
        timeoutMs: 90_000,
        attempts: 2,
        slot,
      },
    );
    return stripFences(out).slice(0, 6000);
  } catch (e) {
    console.error("analyzeChunk failed:", e instanceof Error ? e.message : e);
    return "";
  }
}

/**
 * Writes one image prompt per segment, in batches.
 *
 * `context` carries the chunk brief plus the script lines immediately before
 * this chunk so the model knows where the scene is and who is present — that
 * continuity is what stops panels from losing story detail at chunk boundaries.
 */

export async function writePrompts(
  bible: string,
  segments: Segment[],
  slot = 0,
  context = "",
  brief = "",
): Promise<string[]> {
  const numbered = segments.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");

  const ask = async (segs: Segment[], lines: string, s: number, temp: number) =>
    zaiChat(
      [
        { role: "system", content: PROMPT_SYSTEM },
        {
          role: "user",
          content:
            `CHARACTER BIBLE:\n${bible}\n\n` +
            (context ? `STORY SO FAR (context only — do NOT storyboard these):\n${context}\n\n` : "") +
            (brief
              ? `CHUNK BRIEF (analysis of exactly these lines — obey its SETTING, CAST, OBJECTS, MOOD and per-line BEATS; ` +
                `never add a person the BEATS call 'no people'):\n${brief}\n\n`
              : "") +
            `SCRIPT LINES:\n${lines}\n\nReturn a JSON array with exactly ${segs.length} prompt strings.`,
        },
      ],

      {
        temperature: temp,
        maxTokens: 500 + segs.length * 320,
        // Small batches answer in a few seconds; a call that hangs longer is
        // stuck, so fail over to another key instead of blocking the wave.
        timeoutMs: 60_000,
        attempts: 3,
        slot: s,
      },
    );

  let arr: unknown[] = [];
  try {
    arr = parseJsonArray(await ask(segments, numbered, slot, 0.7));
  } catch (e) {
    console.error("writePrompts first pass failed:", e instanceof Error ? e.message : e);
    arr = [];
  }

  const usable = (v: unknown) => typeof v === "string" && v.trim().length > 30;

  // Repair pass: one timestamp must always get its own prompt, so anything the
  // first pass dropped or truncated is asked for again on a different key.
  const missing = segments.map((_, i) => i).filter((i) => !usable(arr[i]));
  if (missing.length > 0) {
    try {
      const subset = missing.map((i) => segments[i]!);
      const lines = subset.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
      const fixed = parseJsonArray(await ask(subset, lines, slot + 1, 0.5));
      missing.forEach((segIdx, k) => {
        if (usable(fixed[k])) arr[segIdx] = fixed[k];
      });
    } catch (e) {
      console.error("writePrompts repair failed:", e instanceof Error ? e.message : e);
    }
  }

  const locations = parseBeatLocations(brief);
  const casts = parseBeatCast(brief);
  const actions = parseBeatActions(brief);

  // One timestamp = one image: the returned array is always exactly as long as
  // `segments`, in the same order, with a fallback prompt rather than a hole.
  return segments.map((s, i) => {
    const v = arr[i];
    const text = usable(v) ? (v as string).trim() : null;
    const action = actions[i + 1];
    // Safety net: if the model drifted away from the beat's own LOCATION, pin
    // it back so the render can't relocate the scene.
    const pinned = enforceLocation(text ?? fallbackPrompt(s, action), locations[i + 1]);
    // Second safety net: keep the cast exactly as the chunk analysis resolved it
    // (including "nobody"), so pronoun lines can't fall back to the protagonist.
    const cast = enforceCast(pinned, casts[i + 1]);
    // Third safety net: if the prompt lost this line's own action, pin the beat's
    // analysed action back so the image still shows what the script line says.
    return sanitizePrompt(enforceBeatAction(cast, action));
  });
}

/**
 * Reads the action half of 'n) LOCATION: ... | WHO: ... | <action>' out of a
 * chunk brief's BEATS block: 1-based line number -> what visibly happens.
 */
export function parseBeatActions(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-]([^\n]+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const parts = (m[2] ?? "").split("|");
    const action = (parts[parts.length - 1] ?? "").trim().replace(/[.;]+$/, "");
    if (n > 0 && parts.length > 1 && action.length > 3) out[n] = action.slice(0, 220);
  }
  return out;
}

/** Appends the analysed beat action when the prompt no longer reflects it. */
export function enforceBeatAction(prompt: string, action?: string): string {
  if (!action) return prompt;
  const p = prompt.toLowerCase();
  const words = action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return prompt;
  const hits = words.filter((w) => p.includes(w)).length;
  if (hits / words.length >= 0.34) return prompt;
  return `${prompt} This exact moment is shown: ${action}.`;
}


/**
 * Reads 'n) LOCATION: <place> | ...' out of a chunk brief's BEATS block and
 * returns a map of 1-based line number -> location.
 */
export function parseBeatLocations(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-]\s*LOCATION\s*:\s*([^|\n]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const place = (m[2] ?? "").trim().replace(/[.,;]+$/, "");
    if (n > 0 && place.length > 2) out[n] = place.slice(0, 80);
  }
  return out;
}

/**
 * Reads 'WHO: <names|no people>' out of a chunk brief's BEATS block and returns
 * a map of 1-based line number -> resolved cast for that shot.
 */
export function parseBeatCast(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-][^\n]*?WHO\s*:\s*([^|\n]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const who = (m[2] ?? "").trim().replace(/[.,;]+$/, "");
    if (n > 0 && who.length > 1) out[n] = who.slice(0, 120);
  }
  return out;
}

const NO_PEOPLE_RE = /^(no\s*people|none|nobody|no\s*one|no\s*character[s]?)$/i;

/**
 * Pins the prompt's cast to what the chunk analysis resolved.
 *  - 'no people' beats get an explicit empty-environment instruction.
 *  - named beats get the resolved names appended when the prompt omitted them,
 *    so a pronoun line never silently becomes the main character.
 */
export function enforceCast(prompt: string, who?: string): string {
  if (!who) return prompt;
  const cleaned = who.trim();
  if (NO_PEOPLE_RE.test(cleaned)) {
    return `${prompt} ${NO_PEOPLE_GUARD}.`;
  }
  const names = cleaned
    .split(/[,/&]| and /i)
    .map((n) => n.trim())
    .filter((n) => n.length > 1);
  if (names.length === 0) return prompt;
  const p = prompt.toLowerCase();
  const missing = names.filter((n) => {
    const key = n.toLowerCase().replace(/^(the|a|an)\s+/, "");
    const head = key.split(/\s+/)[0] ?? key;
    return !p.includes(key) && !p.includes(head);
  });
  if (missing.length === 0) return prompt;
  return `${prompt} The only people in frame are ${names.join(" and ")}; ${missing.join(
    " and ",
  )} must be present and no other character appears.`;
}


/** True when the prompt already names the location (or most of its words). */
function mentionsLocation(prompt: string, location: string): boolean {
  const p = prompt.toLowerCase();
  if (p.includes(location.toLowerCase())) return true;
  const words = location
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const hits = words.filter((w) => p.includes(w)).length;
  return hits / words.length >= 0.5;
}

export function enforceLocation(prompt: string, location?: string): string {
  if (!location) return prompt;
  if (mentionsLocation(prompt, location)) return prompt;
  return `In ${location}: ${prompt} The scene takes place in ${location}, and nowhere else.`;
}


function fallbackPrompt(s: Segment, action?: string): string {
  return (
    "A single cinematic manga scene, moody low-key lighting with the subject clearly lit, depicting this exact story " +
    `moment: ${action ? action : s.text}`
  );
}



/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [/\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi, "weathered wall"],
  [/\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi, "bare wall"],
  [/\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b/gi, "worn paper object"],
  [/\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi, ""],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [/\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi, "dark glowing screen"],
  [/"[^"]{0,120}"/g, ""],
  [/'[^']{2,120}'/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/**
 * Only the extremes are softened now. The old rules rewrote ANY mention of
 * light into shadow, which stacked with the tone lock and the render grade and
 * made every panel far too dark.
 */
const BRIGHT_TRIGGERS: [RegExp, string][] = [
  [/\b(blinding|dazzling)\s+(sunlight|sunshine|daylight|light|lighting|sun)\b/gi, "soft directional light"],
  [/\b(sun-drenched|sun drenched)\b/gi, "overcast"],
  [/\b(white|pastel|clean white)\s+background\b/gi, "muted grey background"],
  [/\b(midday sun|noon sun|clear blue sky|bright blue sky)\b/gi, "overcast grey sky"],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or blown-out light. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "full colour",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of BRIGHT_TRIGGERS) out = out.replace(re, to);

  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 6);
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Stamp the gender next to each name so the renderer cannot misread it.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male man" : "female woman";
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\b)`, "g"),
      `${e.name} (${noun})`,
    );
  }

  // With two or more people in frame the renderer tends to blend or swap
  // genders, so state the split explicitly right after the scene text.
  if (present.length >= 2) {
    const males = present.filter((e) => genderOf(e.traits) === "male").map((e) => e.name);
    const females = present.filter((e) => genderOf(e.traits) === "female").map((e) => e.name);
    if (males.length > 0 && females.length > 0) {
      out +=
        `. In this frame ${males.join(" and ")} ${males.length > 1 ? "are" : "is"} clearly MALE ` +
        `(masculine face and body, male hairstyle and male clothing), and ` +
        `${females.join(" and ")} ${females.length > 1 ? "are" : "is"} clearly FEMALE ` +
        `(feminine face and body, female hairstyle and female clothing); do not swap, blend or feminise/masculinise them`;
    }
  }
  return out;
}


function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  const matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  // Only lock characters actually present in this scene — never inject
  // the whole cast into a prompt that doesn't mention them.
  if (matched.length === 0) return "";
  return (
    "Fixed character identity (gender and appearance must match exactly for every character, " +
    "never swapped, blended or changed between shots): " +
    matched
      .map((e) => {
        const g = genderOf(e.traits);
        const traits = e.traits.replace(/\.$/, "");
        return g
          ? `${e.name} is a ${g.toUpperCase()} ${g === "male" ? "man/boy" : "woman/girl"} — ${traits}`
          : `${e.name} is ${traits}`;
      })
      .join("; ") +
    (matched.length >= 2
      ? ". Keep each of these characters visually distinct from the others and give each one exactly the gender stated."
      : ".")
  );
}


/** True when the prompt describes at least one human in frame. */
export function hasPeople(prompt: string, bible?: string): boolean {
  const p = prompt.toLowerCase();
  if (/\bno (people|figures?|characters?|humans?)\b|\bempty environment\b|\bunpopulated\b/.test(p))
    return false;
  if (bible && parseBible(bible).some((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt)))
    return true;
  return /\b(man|men|woman|women|boy|boys|girl|girls|child|children|person|people|crowd|figure|silhouette|soldier|guard|villager|student|teacher|shopkeeper|worker|stranger|face|faces|he|she|they)\b/.test(
    p,
  );
}

export function composeImagePrompt(prompt: string, bible?: string): string {
  const fixed = enforceGender(sanitizePrompt(prompt), bible);
  const peopled = hasPeople(fixed, bible);
  // Character lock only matters when someone is actually in frame.
  const lock = peopled ? characterLock(fixed, bible) : "";
  // The scene description leads: Flux weights the earliest tokens most, and it
  // has no negative prompt, so guards are kept short and placed at the end.
  return (
    `${fixed}. ${lock ? lock + " " : ""}${STYLE}, ${NO_TEXT_GUARD}. ` +
    `${peopled ? CAST_GUARD : NO_PEOPLE_GUARD}. ${TONE_LOCK}. ${SINGLE_PANEL_GUARD}. ` +
    `16:9 widescreen cinematic framing.`
  );

}

/**
 * Blank-panel rejection.
 *
 * A blank/solid or nearly-empty Flux frame compresses to a few kilobytes and
 * its compressed bytes carry very little entropy, while a real detailed
 * 1024x576 panel never does. Anything suspiciously small, low-entropy, or not
 * an image at all is treated as blank and re-rendered on another key/seed, so
 * no empty panel can reach the encoder.
 */
const MIN_IMAGE_BYTES = 40_000;
/** Shannon entropy (bits/byte) of compressed image data; real art is > 7.5. */
const MIN_ENTROPY = 7.0;

function byteEntropy(buf: Uint8Array): number {
  const counts = new Uint32Array(256);
  const step = Math.max(1, Math.floor(buf.byteLength / 200_000));
  let n = 0;
  for (let i = 0; i < buf.byteLength; i += step) {
    counts[buf[i]!] = counts[buf[i]!]! + 1;
    n++;
  }
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

async function isRealImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < MIN_IMAGE_BYTES) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45;
    if (!isPng && !isJpg && !isWebp) return false;
    // skip the header before measuring entropy of the compressed payload
    return byteEntropy(buf.subarray(Math.min(2048, buf.byteLength >> 2))) >= MIN_ENTROPY;
  } catch {
    // Network hiccup while probing: don't throw away a probably-good panel.
    return true;
  }
}


/** Calls Flux.1 Schnell (free tier) with automatic retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
): Promise<string> {
  const keys = pixazoKeys();
  const body = composeImagePrompt(prompt, bible).slice(0, 1900);

  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(PIXAZO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": key,
        },
        body: JSON.stringify({
          prompt: body,
          num_steps: 4,
          // a fresh seed each attempt, so a blank frame is never re-rolled identically
          seed: seed + attempt * 977,
          width: 1024,
          height: 576,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { output?: string };
        if (json.output) {
          if (await isRealImage(json.output)) return json.output;
          lastErr = "blank image rejected";
        } else {
          lastErr = "no output url";
        }
      } else {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}
