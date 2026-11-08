/**
 * Two things a Codex runtime does at launch that a session has to answer for
 * (docs/design/account-model.md §8.4; measured on codex 0.162.1, the U4 latest-version drift).
 *
 * ## The app-server daemon a Codex TUI leaves behind
 *
 * Codex starts a background app server under its OWN `CODEX_HOME` the first time a TUI runs there,
 * and it outlives the TUI: two processes, the server and its updater loop, each recorded in a pid
 * file under `<CODEX_HOME>/app-server-daemon/`, each running an executable Codex installed under
 * `<CODEX_HOME>/packages/app-server-daemon/`. `codex app-server daemon stop` stops the server and
 * leaves the updater running, so Ferretry stops both itself.
 *
 * Which daemon is a session's to stop is decided here, and the rule is narrow on purpose:
 *
 * - **Only a runtime's own config directory.** The home comes from the PUBLISHED account the session
 *   ran, and it must lie inside the fleet's homes directory. The person's own `~/.codex` — and any
 *   version-1 home configured outside the fleet — is never a candidate, whatever runs there.
 * - **Only when nothing else uses that home.** Two sessions on one runtime share one `CODEX_HOME`, and
 *   so does the person running that runtime's wrapper in their own terminal. A daemon is stopped only
 *   when no process other than the daemon pair still carries that `CODEX_HOME`.
 * - **Only a process that is that home's daemon.** A pid file is a claim, and a pid can be reused, so
 *   a pid is signalled only when the process's command line is an executable under that home's
 *   `packages/app-server-daemon/`. Anything else is left alone.
 * - **When in doubt, leave it running.** Every unknown — no pid file, a process that cannot be
 *   inspected, a home whose users cannot be listed — ends with the daemon left as Codex left it,
 *   which is exactly what happened before this existed. Stopping is housekeeping; it never fails a
 *   stop or a reap.
 *
 * ## Starting offline
 *
 * With a ChatGPT login, Codex asks the network for "workspace routing" while its TUI boots and exits
 * when it cannot reach it. The pane is left showing a JSON-RPC error and nothing else, so a session
 * that failed this way is told so in words: {@link CODEX_OFFLINE_LAUNCH_ERROR}.
 */

/** The sentence a launch failure starts with when Codex could not reach the network while starting. */
export const CODEX_OFFLINE_LAUNCH_ERROR = 'Codex needs a network connection to start';

/**
 * What Codex prints when its startup network call fails. Matched loosely enough to survive the
 * JSON-RPC code changing, and narrowly enough that no other failure reads as "offline".
 */
const OFFLINE_SIGNATURES: readonly RegExp[] = [/workspace routing discovery failed/iu];

/**
 * The launch error for a Codex pane that died while starting, or `undefined` when its screen does not
 * show the offline failure. `paneText` is what the dead pane last showed.
 */
export function codexLaunchFailure(paneText: string): string | undefined {
  if (!OFFLINE_SIGNATURES.some(signature => signature.test(paneText))) return undefined;
  return `${CODEX_OFFLINE_LAUNCH_ERROR}. It could not reach OpenAI while starting, so the session ended before it could take any work. Check this machine's network connection, then start the session again.`;
}

/** What one call decided, as a value a test can assert on. */
export type CodexAppServerOutcome =
  | { readonly kind: 'not-a-codex-runtime' }
  | { readonly kind: 'in-use'; readonly home: string }
  | { readonly kind: 'not-running'; readonly home: string }
  | { readonly kind: 'stopped'; readonly home: string; readonly pids: readonly number[] }
  | { readonly kind: 'undecided'; readonly reason: string };
