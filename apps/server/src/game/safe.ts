// Lookups for Record<string, …> objects keyed by ids that may come from clients.
// Plain `obj[id]` would find inherited members like "constructor" or "__proto__".

/** Own-property read: inherited keys never match. */
export function own<T>(obj: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Ids we accept as object keys: short, and never "__proto__" (writing that key changes the prototype). */
export function isSafeKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 64 && key !== '__proto__';
}

/**
 * Checks a Record read from a snapshot file: a plain object whose keys are safe ids
 * and whose values pass `check`. Returns a clean copy; throws with `what` in the message otherwise.
 */
export function cleanRecord<T>(
  raw: unknown,
  check: (value: unknown, key: string) => boolean,
  what: string,
): Record<string, T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid snapshot: ${what} is not an object`);
  }
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeKey(key) || !check(value, key)) throw new Error(`Invalid snapshot: ${what}.${key}`);
    out[key] = value as T;
  }
  return out;
}

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
