/**
 * Leftover cleanup without an investigation.
 *
 * A finished ferret that left a headless browser running under its pane is not a mystery worth an LLM:
 * the turn is over, nothing of the agent's own is running, and the browser only holds memory. The Warden paid
 * an investigation each time to read that off the screen and answer "harmless, leave it" — or "a leaked
 * browser, stop the session", which threw the conversation away to free one browser.
 *
 * THE RULE. A ferret whose turn is over (at its prompt, or its done marker written), with no tool command
 * running, whose pane has had a browser it launched for at least {@link LEFTOVER_BROWSER_GRACE_MS}, gets
 * that browser closed — only the browser, never the ferret — when the owner lets the Warden
 * `closeLeftovers` alone. The process tree is read again at the moment of closing (`WardenRemedyPort`),
 * so a decision made on an older look can never close something else.
 *
 * Pure: no IO, no clock, no globals.
 */

import { ledgerAges } from './sus.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, livenessLedgerOf, WARDEN_LABEL, type WardenSessionView } from './types.ts';

/** How long a browser must outlive the turn before it is a leftover rather than about to be used. */
export const LEFTOVER_BROWSER_GRACE_MS = 10 * 60_000;

export interface LeftoverBrowserCandidate {
  readonly sessionId: string;
  /** Since when the browser has been running under the pane, this turn. */
  readonly since: string;
}

/** The ferrets whose leftover browser may be closed now. */
export function leftoverBrowserCandidates(
  sessions: readonly WardenSessionView[],
  nowMs: number,
  options: { readonly graceMs?: number; readonly tickSeconds: number },
): readonly LeftoverBrowserCandidate[] {
  const graceMs = options.graceMs ?? LEFTOVER_BROWSER_GRACE_MS;
  const candidates: LeftoverBrowserCandidate[] = [];
  for (const view of sessions) {
    const since = view.leftoverBrowserSince;
    const sinceMs = instantMs(since);
    if (since === undefined || sinceMs === undefined || nowMs - sinceMs < graceMs) continue;
    // A person's own terminal and a warden's own session are never cleaned up after.
    if (view.config.mode === 'interactive' || view.config.label === WARDEN_LABEL || view.config.wardenLineage) continue;
    if (isTerminalStatus(view.state.status)) continue;
    const turnOver = view.state.turnState === 'your-turn' || view.hasDoneMarker === true;
    if (!turnOver || view.state.turnState === 'working' || view.state.turnState === 'needs-input') continue;
    const ages = ledgerAges(livenessLedgerOf(view.state), nowMs);
    if (ages.subprocess <= 2 * options.tickSeconds) continue;
    candidates.push({ sessionId: view.config.id, since });
  }
  return candidates;
}
