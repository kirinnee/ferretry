import type { HarnessDialog, SessionState } from '@ferretry/protocol';

/**
 * A LOGIN THE PANES SAY IS OUT OF QUOTA.
 *
 * The usage feed reads a login's windows from the provider and its own statusline; it cannot see a
 * spend limit that the provider only announces on the pane ("You've hit your org's monthly spend
 * limit"). A session parked on that dialog is recorded `rate_limited` (see `session/turn/usage-limit.ts`),
 * and this module turns those sessions into the logins they prove spent, so the feed (quota failover)
 * and `fy recommend` count the login exhausted until the time the harness gave.
 *
 * Derived from session documents on every read — nothing is remembered here, so it survives a restart
 * and ends the moment the last session on the login is released.
 *
 * Pure: session facts and a clock in, a value out.
 */

/** What a pane proved about one login. */
export interface PaneLimit {
  /** The harness's own sentence. */
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the login is usable again, epoch milliseconds; absent when the harness gave no time. */
  readonly retryAt?: number;
}

/** One session, as far as this module reads it. */
export interface PaneLimitSession {
  /** The executable (wrapper) name the session was launched with. */
  readonly agent: string;
  readonly status: SessionState['status'];
  readonly quota?: SessionState['quota'] | undefined;
  readonly harnessDialog?: Pick<HarnessDialog, 'kind' | 'body' | 'title'> | undefined;
}

/** Whether a limit still holds at `nowMs`: one with a reset time ends there, one without ends with its sessions. */
export const paneLimitHolds = (limit: PaneLimit, nowMs: number): boolean =>
  limit.retryAt === undefined || limit.retryAt > nowMs;

/** The limits live sessions prove, by agent. Where several sessions share one, the latest reset wins. */
export function sessionPaneLimits(sessions: Iterable<PaneLimitSession>, nowMs: number): ReadonlyMap<string, PaneLimit> {
  const limits = new Map<string, PaneLimit>();
  for (const session of sessions) {
    if (session.status !== 'rate_limited' || session.harnessDialog?.kind !== 'usage-limit') continue;
    const notice = session.harnessDialog.body?.split('\n')[0]?.trim() || session.harnessDialog.title;
    const retryAt = session.quota?.retryAt;
    const limit: PaneLimit = {
      notice,
      spend: session.quota?.unavailableReason === 'spend_limit',
      ...(retryAt === undefined ? {} : { retryAt }),
    };
    if (!paneLimitHolds(limit, nowMs)) continue;
    const kept = limits.get(session.agent);
    if (kept === undefined || (kept.retryAt !== undefined && (retryAt === undefined || retryAt > kept.retryAt)))
      limits.set(session.agent, limit);
  }
  return limits;
}

/** The same limits by login: every login a limited agent runs on is as spent as the agent's session proved. */
export function limitedCredentials(
  limits: ReadonlyMap<string, PaneLimit>,
  runtimes: Iterable<{ readonly agent: string; readonly credential: string }>,
): ReadonlyMap<string, PaneLimit> {
  const byCredential = new Map<string, PaneLimit>();
  for (const runtime of runtimes) {
    const limit = limits.get(runtime.agent);
    if (limit !== undefined && !byCredential.has(runtime.credential)) byCredential.set(runtime.credential, limit);
  }
  return byCredential;
}
