import type { PullFile } from '../../../contract/index.ts';

/**
 * "Viewed" ticks, kept on THIS device only (a tick is how this person reads a PR, not something GitHub or another device
 * needs). A tick belongs to a file AS IT WAS: its fingerprint changes when the file's diff changes, so a file that changed
 * after it was ticked reads as unviewed again.
 */

/** FNV-1a over the diff text, as hex: small, stable and not a security boundary. */
const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

export const viewedKey = (file: PullFile): string =>
  `${file.path}@${file.status}:${file.additions}:${file.deletions}:${fingerprint(file.patch ?? '')}`;

/** What the ticks need of `localStorage`; a browser that refuses it just forgets. */
export interface TickStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The most ticks kept for one PR: a bound, so a 3000-file PR cannot grow the store without end. */
const MAX_TICKS = 3000;

export const tickStorageKey = (scope: string): string => `fy.pulls.viewed.${scope}`;

export function readTicks(storage: TickStorage | undefined, scope: string): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(tickStorageKey(scope));
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeTicks(storage: TickStorage | undefined, scope: string, ticks: ReadonlySet<string>): void {
  try {
    storage?.setItem(tickStorageKey(scope), JSON.stringify([...ticks].slice(-MAX_TICKS)));
  } catch {
    // Private mode or a full store: the ticks last for this visit only.
  }
}

/** The device's storage, or nothing where the browser gives none. */
export const deviceStorage = (): TickStorage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};
