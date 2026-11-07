/**
 * TEST FIXTURE: today's `paneShowsStartupWait` from `packages/daemon/src/lib/tmux/pane.ts` (owner: terminals), which the
 * fixture's picker driver reads.
 */
/**
 * Codex's `Waiting for startup  · esc cancel`: a submission it has accepted and PARKED.
 *
 * From Codex 0.166 the composer is drawn before startup has finished — startup waits on an
 * `account/read` round trip to chatgpt.com that can run to a fifteen-second timeout — and a payload
 * submitted in that window stays drawn in the composer with this line beneath it until startup ends,
 * when Codex sends it. Escape cancels the park and leaves the same text as an ordinary draft, which is
 * why the line, not the composer, is the proof that the submission was taken. Measured on 0.166.0
 * (`tests/fixtures/composer/codex-0.166.0-startup-*`).
 *
 * Only the LAST drawn line counts: the line sits directly under the composer, at the bottom of the
 * pane, and the same words anywhere above it are conversation — a transcript about this very screen,
 * for instance — not the harness speaking.
 */
const CODEX_STARTUP_WAIT = /^\s*waiting for startup\s+[·•]\s+esc cancel\s*$/u;

/** Whether Codex is holding a submission until its own startup finishes. */
export function paneShowsStartupWait(pane: string): boolean {
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n');
  return CODEX_STARTUP_WAIT.test((lines.at(-1) ?? '').toLowerCase());
}
