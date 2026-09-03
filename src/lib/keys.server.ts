/**
 * API key pools.
 *
 * Both providers are used with several keys at once so scenes can be
 * generated in parallel instead of queueing behind one key's rate limit.
 * Keys are read from PIXAZO_API_KEY_1..N / PARALON_API_KEY_1..N with the
 * unsuffixed name kept as a fallback for single-key setups.
 */

function readPool(prefix: string): string[] {
  const keys: string[] = [];
  const base = process.env[prefix];
  if (base) keys.push(base.trim());
  for (let i = 1; i <= 12; i++) {
    const v = process.env[`${prefix}_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  // de-dupe so the unsuffixed fallback doesn't double one key's weight
  return [...new Set(keys)];
}

export function pixazoKeys(): string[] {
  const keys = readPool("PIXAZO_API_KEY");
  if (keys.length === 0) throw new Error("Missing PIXAZO_API_KEY");
  return keys;
}

export function paralonKeys(): string[] {
  const keys = readPool("PARALON_API_KEY");
  if (keys.length === 0) throw new Error("Missing PARALON_API_KEY");
  return keys;
}

/**
 * Deterministic spread: a caller passes the scene index as `slot`, so
 * consecutive scenes running at the same time land on different keys.
 * `attempt` shifts to the next key so a retry never hits the key that
 * just rate-limited or errored.
 */
export function pickKey(keys: string[], slot: number, attempt = 0): string {
  const n = keys.length;
  const i = (((slot % n) + n) % n + attempt) % n;
  return keys[i] as string;
}
