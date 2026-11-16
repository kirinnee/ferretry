/**
 * Starting Codex offline (docs/design/account-model.md §8.4; measured on codex 0.162.1).
 *
 * With a ChatGPT login, Codex asks the network for "workspace routing" while its TUI boots and exits when it cannot
 * reach it. The pane is left showing a JSON-RPC error and nothing else, so a ferret that failed this way is told so in
 * words: {@link CODEX_OFFLINE_LAUNCH_ERROR}. Runtimes owns the fact (it is what a Codex runtime does at launch); the
 * Codex harness answers a failed start with it (`Harness.startFailure`), and Runtimes' own end supervision reads it too.
 * Pure, and never quotes the screen it reads.
 */

/** The sentence a launch failure starts with when Codex could not reach the network while starting. */
export const CODEX_OFFLINE_LAUNCH_ERROR = 'Codex needs a network connection to start';

/**
 * What Codex prints when its startup network call fails. Matched loosely enough to survive the JSON-RPC code changing,
 * and narrowly enough that no other failure reads as "offline".
 */
const OFFLINE_SIGNATURES: readonly RegExp[] = [/workspace routing discovery failed/iu];

/**
 * The launch error for a Codex pane that died while starting, or `undefined` when its screen does not show the offline
 * failure. `paneText` is what the dead pane last showed. Today's text, word for word.
 */
export function codexLaunchFailure(paneText: string): string | undefined {
  if (!OFFLINE_SIGNATURES.some(signature => signature.test(paneText))) return undefined;
  return `${CODEX_OFFLINE_LAUNCH_ERROR}. It could not reach OpenAI while starting, so the session ended before it could take any work. Check this machine's network connection, then start the session again.`;
}
