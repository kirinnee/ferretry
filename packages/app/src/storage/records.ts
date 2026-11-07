import type { z } from 'zod';

/**
 * A browser key-value store, reduced to the two calls the app uses. `localStorage` and `sessionStorage` satisfy it;
 * tests pass a map. A browser that refuses storage (a private window, a sandbox) is `null` at the composition root.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The one stored format (§9.4: `format: 1` inside, no version in the name). */
export const RECORD_FORMAT = 1 as const;

/**
 * Reads one stored record. A missing entry, unparseable JSON, another `format` or a body the schema refuses all read as
 * `undefined`: browser storage is a cache any page on the origin can write, never a source of truth, and there is no
 * converter for another format (clean slate). The caller's default applies.
 */
export function readRecord<S extends z.ZodType>(
  store: KeyValueStore | null,
  key: string,
  schema: S,
): z.infer<S> | undefined {
  let raw: string | null;
  try {
    raw = store?.getItem(key) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { format, value } = parsed as { format?: unknown; value?: unknown };
  if (format !== RECORD_FORMAT) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Writes one record as `{ format: 1, value }`. A full or refused store costs only the memory; it never throws. */
export function writeRecord(store: KeyValueStore | null, key: string, value: unknown): boolean {
  try {
    store?.setItem(key, JSON.stringify({ format: RECORD_FORMAT, value }));
    return store !== null;
  } catch {
    return false;
  }
}

export function removeRecord(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // A refused store has nothing to remove.
  }
}

/** An in-memory store: tests, and the fallback where the browser refuses storage. */
export function memoryStore(initial: Readonly<Record<string, string>> = {}): KeyValueStore & {
  readonly entries: () => Readonly<Record<string, string>>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    entries: () => Object.fromEntries(map),
  };
}
