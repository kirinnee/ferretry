/**
 * What the Codex pane says about its own startup, and how a typed command ended.
 *
 * Both are read off captured pane text and are Codex's own wording, so they live with the picker that depends on
 * them rather than in the terminal layer.
 */

/**
 * How a command typed into the harness ended: `turn-started` means the harness read it as a message and a model turn
 * followed; `handled-local` means the harness consumed it itself (a `/model` that opened its picker).
 */
export type InjectionOutcome = 'turn-started' | 'handled-local';

/**
 * Codex's `Waiting for startup  · esc cancel`: a submission it has accepted and PARKED.
 *
 * From Codex 0.166 the composer is drawn before startup has finished — startup waits on an `account/read` round trip
 * to chatgpt.com that can run to a fifteen-second timeout — and a payload submitted in that window stays drawn in the
 * composer with this line beneath it until startup ends, when Codex sends it. Escape cancels the park and leaves the
 * same text as an ordinary draft, which is why the line, not the composer, is the proof that the submission was taken.
 * Measured on 0.166.0.
 *
 * Only the LAST drawn line counts: the line sits directly under the composer, at the bottom of the pane, and the same
 * words anywhere above it are conversation — a transcript about this very screen, for instance — not the harness
 * speaking.
 */
const CODEX_STARTUP_WAIT = /^\s*waiting for startup\s+[·•]\s+esc cancel\s*$/u;

/** Whether Codex is holding a submission until its own startup finishes. */
export function paneShowsStartupWait(pane: string): boolean {
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n');
  return CODEX_STARTUP_WAIT.test((lines.at(-1) ?? '').toLowerCase());
}
