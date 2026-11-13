/**
 * What a sign-in surface SAYS — the pure half, so every sentence a person reads is pinned by a test.
 *
 * The daemon owns the FACTS and this owns the PROSE. Splitting it that way is why the daemon's wire
 * contract carries no display strings: two owners for one sentence is how a refusal ends up worded
 * differently in two places.
 */

/** Humanised time until an instant, or `null` when there is nothing to say. */
export function timeUntil(iso: string | undefined, nowMs: number): string | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}

/**
 * The words a sign-in panel uses for one LOGIN (docs/design/account-model.md §4.6). The surface never
 * shows an identity, a wrapper or a sibling copy (§4.1 rule 8), so the panel takes its sentences from here.
 */
export interface LoginPanelWording {
  /** Under the header: what one sign-in covers ("Every runtime that uses it can launch once it is done."). */
  readonly coverage: string;
  /** Once the harness accepted the sign-in ("Signed in. 3 runtimes can launch now."). */
  readonly signedIn: string;
  /** The finish button ("Finish sign-in for 3 runtimes"); Claude only, Codex has no button. */
  readonly finishLabel?: string;
}
