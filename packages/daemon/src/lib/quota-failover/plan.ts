/**
 * One tick's decision, as a plan: what would be moved, where, on what evidence, and why every other
 * session was left alone.
 *
 * PLANNING IS SEPARATE FROM ACTING because the act is destructive. A pure function from a snapshot of
 * the world to a list of intentions can be exercised exhaustively — every refusal, every ambiguity,
 * every damaged input — without anything ever killing a pane, and the service that carries the plan
 * out has nothing left to decide.
 *
 * A HALT IS NOT AN EMPTY PLAN. "Nothing needed moving" and "this tick could not tell whether anything
 * needed moving" are different facts and they are different variants here, because reporting the
 * second as the first is exactly the "absent evidence read as a benign result" failure this
 * subsystem is most exposed to: the feed is down, so no account looks exhausted, so all is well.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { AccountUsage, SessionStatus } from '@ferretry/protocol';
import type { CoreAccount } from '../core/inventory.ts';
import { usageForAgent } from '../usage/account-health.ts';
import { type FailoverTarget, selectFailoverTarget } from './candidates.ts';
import {
  type QuotaFailoverConfig,
  quotaFailoverPool,
  retryCooldownMs,
  revisitCooldownMs,
  snapshotAgeCeilingMs,
} from './config.ts';
import { quotaExhaustionReason, snapshotRefusal } from './evidence.ts';
import { attemptRefusal, barredTargets, type QuotaFailoverState, sessionRecord } from './ledger.ts';

/** One session, as a tick reads it. */
export interface QuotaFailoverSession {
  readonly id: string;
  /** The account it is running on now. */
  readonly agent: string;
  /** The harness family its configuration document records. */
  readonly harness: string;
  readonly status: SessionStatus;
}

/**
 * The statuses a session may be moved out of.
 *
 * The list is what it is for reasons, not for tidiness. `created` and `starting` are excluded because
 * the launch is in flight and a migration would race the very pane it is about to inspect.
 * `retrying` is excluded because a relaunch is already booked and moving the account underneath it
 * would have the retry come up on a document that changed after it was scheduled. `kill_failed` is
 * excluded because the fate of the previous terminal is exactly what is unknown, and every terminal
 * status — `completed`, `failed`, `stopped` — is excluded because there is no next turn to protect.
 */
const MOVABLE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'waiting',
  'stalled',
]);

/** A session this tick intends to move, with everything the journal entry needs. */
export interface QuotaFailoverMigration {
  readonly session: QuotaFailoverSession;
  readonly target: FailoverTarget;
  /** The measured reading that made the source account exhausted. */
  readonly evidence: string;
  /** Why every other pool account was not the target. */
  readonly rejected: Readonly<Record<string, string>>;
}

/** A session this tick deliberately left alone, and the reason a human would want. */
export interface QuotaFailoverSkip {
  readonly sessionId: string;
  readonly reason: string;
}

/**
 * A session that is out of tokens and has nowhere to go.
 *
 * Its own variant rather than a skip, because it is the one outcome an operator has to act on: the
 * pool itself is exhausted, and no amount of waiting for the next tick changes that.
 */
export interface QuotaFailoverStranded {
  readonly sessionId: string;
  readonly agent: string;
  readonly evidence: string;
  readonly rejected: Readonly<Record<string, string>>;
}

export type QuotaFailoverPlan =
  | { readonly kind: 'halted'; readonly reason: string }
  | {
      readonly kind: 'planned';
      readonly migrations: readonly QuotaFailoverMigration[];
      readonly stranded: readonly QuotaFailoverStranded[];
      readonly skipped: readonly QuotaFailoverSkip[];
    };

export interface QuotaFailoverPlanInput {
  readonly config: QuotaFailoverConfig;
  readonly state: QuotaFailoverState;
  readonly sessions: readonly QuotaFailoverSession[];
  readonly accounts: readonly CoreAccount[];
  readonly usage: readonly AccountUsage[];
  /** When the usage rows were collected, from the feed itself. */
  readonly snapshotAt: number | undefined;
  readonly nowMs: number;
}

/** What this tick would do, given everything it can see. */
export function planQuotaFailover(input: QuotaFailoverPlanInput): QuotaFailoverPlan {
  if (!input.config.enabled) return { kind: 'halted', reason: 'automatic quota failover is disabled (enabled=false)' };
  const pool = quotaFailoverPool(input.config);
  if (pool.length === 0)
    return {
      kind: 'halted',
      reason:
        'automatic quota failover is enabled but no accounts are pooled, so no session is opted in and no ' +
        'account is a candidate target',
    };
  // The freshness gate sits above every session, because it is a statement about the evidence rather
  // than about any one of them. A stale snapshot cannot be salvaged per session.
  const stale = snapshotRefusal(input.snapshotAt, input.nowMs, snapshotAgeCeilingMs(input.config));
  if (stale !== undefined) return { kind: 'halted', reason: stale };

  const migrations: QuotaFailoverMigration[] = [];
  const stranded: QuotaFailoverStranded[] = [];
  const skipped: QuotaFailoverSkip[] = [];
  const barredCooldownMs = revisitCooldownMs(input.config);
  const limits = { maxMoves: input.config.maxMovesPerSession, retryCooldownMs: retryCooldownMs(input.config) };

  for (const session of input.sessions) {
    if (!pool.includes(session.agent)) {
      skipped.push({
        sessionId: session.id,
        reason: `${session.agent} is not in the quota-failover pool, so this session has not opted in`,
      });
      continue;
    }
    if (!MOVABLE_STATUSES.has(session.status)) {
      skipped.push({
        sessionId: session.id,
        reason: `its status is ${session.status}, which has no next turn to protect`,
      });
      continue;
    }
    const evidence = quotaExhaustionReason(usageForAgent(input.usage, session.agent));
    if (evidence === undefined) {
      skipped.push({ sessionId: session.id, reason: `nothing measured says ${session.agent} is out of tokens` });
      continue;
    }
    const record = sessionRecord(input.state, session.id);
    const spent = attemptRefusal(record, limits, input.nowMs);
    if (spent !== undefined) {
      skipped.push({ sessionId: session.id, reason: spent });
      continue;
    }
    const selection = selectFailoverTarget({
      sourceAgent: session.agent,
      sourceHarness: session.harness,
      pool,
      accounts: input.accounts,
      usage: input.usage,
      headroomPercent: input.config.headroomPercent,
      barred: barredTargets(record, barredCooldownMs, input.nowMs),
    });
    if (selection.target === undefined) {
      stranded.push({ sessionId: session.id, agent: session.agent, evidence, rejected: selection.rejected });
      continue;
    }
    migrations.push({ session, target: selection.target, evidence, rejected: selection.rejected });
  }

  return { kind: 'planned', migrations, stranded, skipped };
}
