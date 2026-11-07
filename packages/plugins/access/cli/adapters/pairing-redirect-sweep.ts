import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  isPairingRedirectDirectoryName,
  isPairingRedirectStale,
  PAIRING_REDIRECT_FILE_NAME,
  PairingRedirectsFile,
} from '../../contract/index.ts';

/** TODO(kernel contract): same scoped metadata/empty-directory ports as the daemon's boot adapter. */
interface RedirectState extends StatePort {
  lstat(
    file: typeof PairingRedirectsFile,
    name: string,
  ): Promise<
    | {
        readonly kind: 'file' | 'directory' | 'symlink' | 'other';
        readonly modifiedMs: number;
      }
    | undefined
  >;
  removeEmptyDirectory(file: typeof PairingRedirectsFile, name: string): Promise<void>;
}

/** The CLI and daemon now share Access's declared opaque tree, rather than reading arbitrary home files. */
export async function sweepPairingRedirectState(port: StatePort | undefined, nowMs: number): Promise<void> {
  const pending = port as Partial<RedirectState> | undefined;
  if (pending?.lstat === undefined || pending.removeEmptyDirectory === undefined) return;
  const state = pending as RedirectState;
  try {
    for (const directory of await state.list(PairingRedirectsFile)) {
      if (!isPairingRedirectDirectoryName(directory)) continue;
      try {
        const parent = await state.lstat(PairingRedirectsFile, directory);
        if (parent?.kind !== 'directory') continue;
        const page = `${directory}/${PAIRING_REDIRECT_FILE_NAME}`;
        const details = await state.lstat(PairingRedirectsFile, page).catch(() => undefined);
        if (!isPairingRedirectStale((details ?? parent).modifiedMs, nowMs)) continue;
        if (details?.kind === 'file') await state.remove(PairingRedirectsFile, page);
        await state.removeEmptyDirectory(PairingRedirectsFile, directory);
      } catch {
        /* A sweep never prevents a pairing. */
      }
    }
  } catch {
    /* An absent tree is the ordinary first-run state. */
  }
}

/**
 * Removes the pairing redirect pages a killed `fy pair --open` left behind in a state home.
 *
 * `fy pair` deletes its page seconds after it is written, and on a clean exit or a signal. A `SIGKILL`
 * or a power loss gives it no chance to, so the page — which holds a pairing code — would sit in the
 * state home until somebody noticed. The code in it is dead within two minutes of being minted, so what
 * is left is a stale credential and not a live one, but "stale and still on disk" is not a state worth
 * keeping. The next `fy pair` and the daemon's boot both run this, whichever comes first.
 *
 * ONLY WHAT `fy pair` MAKES IS TOUCHED, AND NOTHING IS FOLLOWED. A directory is considered only when its
 * name is exactly the shape `mkdtemp` gives ours and `readdir` reports it as a real directory — a
 * symbolic link with that name is a plain non-match, so a planted link can never aim a delete at
 * somebody else's files. Inside it exactly one file name is removed, and only when `lstat` says it is a
 * regular file; the directory is then removed with `rmdir`, which refuses to take anything it still
 * holds. Anything unexpected is left where it is.
 *
 * A PAGE YOUNGER THAN `PAIRING_REDIRECT_STALE_AFTER_MS` IS LEFT ALONE: this runs in a different process
 * from the one that wrote it, and a `fy pair` running at this moment has not yet had its browser read it.
 *
 * IT NEVER THROWS. An absent state home is the ordinary first-run answer, and a sweep that cannot finish
 * must not stop a pairing or a boot — it reports how many pages it removed and says nothing otherwise.
 */
export async function sweepPairingRedirects(stateHome: string, nowMs: number): Promise<number> {
  let entries: readonly { readonly name: string; readonly isDirectory: () => boolean }[];
  try {
    entries = await readdir(stateHome, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isPairingRedirectDirectoryName(entry.name)) continue;
    const directory = join(stateHome, entry.name);
    try {
      const page = join(directory, PAIRING_REDIRECT_FILE_NAME);
      const details = await lstat(page).catch(() => undefined);
      // A directory with no page is an interrupted write, aged by its own time instead of the page's.
      const written = details ?? (await lstat(directory));
      if (!isPairingRedirectStale(written.mtimeMs, nowMs)) continue;
      if (details?.isFile() === true) {
        await unlink(page);
        removed += 1;
      }
      await rmdir(directory);
    } catch {
      // Held open elsewhere, not ours after all, or already gone: none of it is this sweep's to settle.
    }
  }
  return removed;
}
