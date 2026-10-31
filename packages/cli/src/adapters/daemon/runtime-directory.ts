import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * The per-user runtime directory the lifecycle claim may live in, or `undefined` when there is none
 * this process can trust.
 *
 * `XDG_RUNTIME_DIR` (`/run/user/<uid>` under systemd) is created `0700` and owned by the user, so no
 * other local user can pre-create a name inside it. The CLI cannot assume that from the variable
 * alone — it is only a path — so the directory is accepted only when it is absolute, really is a
 * directory, is owned by THIS user, and grants nothing to group or other. Anything else (unset, a
 * relative path, a shared or foreign directory, a missing one, a host without the concept such as
 * macOS) answers `undefined` and the layout falls back to the shared `/tmp` name, which is the
 * pre-existing behaviour and is documented as a declared limit on multi-user hosts.
 *
 * `statSync` follows links on purpose: the variable is the user's own, and a launcher that points it
 * through a link still lands in the directory that was checked.
 */
export function privateRuntimeDirectory(candidate: string | undefined, userId: number): string | undefined {
  if (candidate === undefined || !isAbsolute(candidate)) return undefined;
  try {
    const state = statSync(candidate);
    if (!state.isDirectory() || state.uid !== userId || (state.mode & 0o077) !== 0) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}
