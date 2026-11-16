/**
 * The checks the config files remember, so one load does not parse the same text twice. Bounded by construction:
 *
 * - **Only a load keeps a check** ({@link ConfigCheckMemo.keep}), and every load then forgets every file it did not
 *   find ({@link ConfigCheckMemo.keepOnly}). So the memo describes the files the last load settled and nothing else: a
 *   write that is refused (under a new name, say) leaves nothing behind, however many there are.
 * - **At most {@link CHECKS_KEPT} checks per file**: the accepted text, the one on disk, and one being written.
 * - **A text is never a key.** A check is found by the sha256 of its text, so a text that was refused — a pasted
 *   secret, say — is not held here by its key; only a check of a text a load read from disk (which the load holds
 *   anyway) is kept at all.
 *
 * Together: at most {@link CHECKS_KEPT} times the number of files settled.
 */
import type { checkConfigText } from './check.ts';

type Checked = ReturnType<typeof checkConfigText>;

/** How many texts of one file keep their check: the accepted one, the one on disk, and one being written. */
export const CHECKS_KEPT = 3;

export interface ConfigCheckMemo {
  /** The check kept for this file's text with this digest, if one is. */
  get(path: string, digest: string): Checked | undefined;
  /** Keep a check a load made; the oldest of this file's goes when it already keeps {@link CHECKS_KEPT}. */
  keep(path: string, digest: string, checked: Checked): void;
  /** Forget every file `present` does not hold. */
  keepOnly(present: { has(path: string): boolean }): void;
  /** How many checks are kept, across every file. */
  size(): number;
}

export function createConfigCheckMemo(): ConfigCheckMemo {
  const byPath = new Map<string, Map<string, Checked>>();
  return {
    get: (path, digest) => byPath.get(path)?.get(digest),
    keep(path, digest, checked) {
      let byDigest = byPath.get(path);
      if (byDigest === undefined) {
        byDigest = new Map();
        byPath.set(path, byDigest);
      }
      byDigest.delete(digest);
      if (byDigest.size >= CHECKS_KEPT) byDigest.delete(byDigest.keys().next().value as string);
      byDigest.set(digest, checked);
    },
    keepOnly(present) {
      for (const path of [...byPath.keys()]) if (!present.has(path)) byPath.delete(path);
    },
    size: () => [...byPath.values()].reduce((sum, byDigest) => sum + byDigest.size, 0),
  };
}
