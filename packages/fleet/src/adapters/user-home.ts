import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * This machine's user home, as every Ferretry program must agree on it: `HOME` when it is set to an
 * absolute path, otherwise the account's home from the system's user database.
 *
 * `homedir()` ALONE IS NOT THE ANSWER UNDER BUN. It reads `HOME` only as the process was started with
 * it, returns a relative `HOME` as it stands, and ignores any later assignment to `process.env.HOME`
 * — so a program that computed a home itself and one that asked `homedir()` could name different
 * directories, and a daemon launched without `HOME` looked for a harness login in the owner's real
 * `~/.claude` and `~/.codex`. That is the one place an isolated run, a release smoke or an end-to-end
 * test must never reach, because a first run copies a credential out of what it finds there. Every
 * Ferretry program asks here instead, so `fy`, `fyd` and the harnesses they launch all name the same
 * directory.
 *
 * A relative or empty `HOME` is not a home, so it falls through to the user database rather than
 * resolving against whatever directory the process happened to start in.
 */
export function resolveUserHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  accountHome: () => string = homedir,
): string {
  const declared = environment.HOME;
  return declared !== undefined && isAbsolute(declared) ? declared : accountHome();
}
