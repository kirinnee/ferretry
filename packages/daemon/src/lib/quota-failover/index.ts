/**
 * Automatic quota failover: moving a session off an account that has measurably run out of tokens,
 * onto a pooled same-kind account with confirmed headroom, through the migration preflight.
 *
 * THE CAPABILITY THIS COMPLETES. `fy migrate` and the daemon's migration mount were already a
 * complete, gated, safe way for a HUMAN to move a session. What did not exist was anything that
 * noticed the account had run out, and the journey the product advertises — "migrate between
 * accounts when you run out of tokens" — is that noticing. Everything here is detection, target
 * selection and bookkeeping; the move itself is the migration that already existed, called through a
 * port that offers no way to force past its refusals.
 *
 * THE FIVE PROPERTIES IT IS BUILT AROUND, and where each one lives:
 *
 *   1. NEVER MIGRATE ON A GUESS — `evidence.ts`. Exhaustion must be measured: a failed probe, an
 *      absent row, or a rejected credential are all "not exhausted" rather than "probably".
 *   2. HEADROOM IS CONFIRMED, NOT ASSUMED — `evidence.ts` again, from the other side. A target must
 *      have been positively scored, explicitly not at its limit, and measured below a ceiling.
 *   3. THE PREFLIGHT IS THE GATE — `ports.ts`. The migrator port takes a session and an account and
 *      nothing else; there is no force flag to pass and no downgrade to accept.
 *   4. A HUMAN CAN SEE IT — `service.ts`. Every move, every refusal and every stranded session is
 *      written onto the session's own journal, and the tick's account is published to the ledger.
 *   5. NEVER LOOP — `ledger.ts`. A durable per-session move budget and a cooldown on both ends of
 *      every previous move, with a damaged ledger halting failover rather than resetting it.
 *
 * OPT-IN IS PER ACCOUNT, by pooling the accounts that are interchangeable. `config.ts` says why, and
 * what the per-session refinement would take.
 */

export {
  type FailoverCandidateInput,
  type FailoverSelection,
  type FailoverTarget,
  selectFailoverTarget,
} from './candidates.ts';
export {
  defaultQuotaFailoverConfig,
  MINIMUM_QUOTA_FAILOVER_INTERVAL_MS,
  parseStoredQuotaFailoverConfig,
  type QuotaFailoverConfig,
  QuotaFailoverConfigSchema,
  quotaFailoverIntervalMs,
  quotaFailoverPool,
  retryCooldownMs,
  revisitCooldownMs,
  type StoredQuotaFailoverConfig,
  snapshotAgeCeilingMs,
} from './config.ts';
export { type HeadroomVerdict, headroom, quotaExhaustionReason, snapshotRefusal } from './evidence.ts';
export {
  attemptRefusal,
  barredTargets,
  emptyQuotaFailoverState,
  parseStoredQuotaFailoverState,
  pruneLedger,
  type QuotaFailoverMove,
  type QuotaFailoverSessionRecord,
  type QuotaFailoverState,
  recordAttempt,
  recordTick,
  type StoredQuotaFailoverState,
  sessionRecord,
} from './ledger.ts';
export {
  planQuotaFailover,
  type QuotaFailoverMigration,
  type QuotaFailoverPlan,
  type QuotaFailoverPlanInput,
  type QuotaFailoverSession,
  type QuotaFailoverSkip,
  type QuotaFailoverStranded,
} from './plan.ts';
export type {
  QuotaFailoverClock,
  QuotaFailoverConfigStore,
  QuotaFailoverJournal,
  QuotaFailoverMigrator,
  QuotaFailoverRoster,
  QuotaFailoverStateStore,
} from './ports.ts';
export {
  QUOTA_FAILOVER_MOVED_EVENT,
  QUOTA_FAILOVER_REFUSED_EVENT,
  QUOTA_FAILOVER_STRANDED_EVENT,
  type QuotaFailoverFailure,
  type QuotaFailoverLoop,
  type QuotaFailoverMoved,
  type QuotaFailoverParts,
  QuotaFailoverService,
  type QuotaFailoverStrandedReport,
  type QuotaFailoverTickReport,
} from './service.ts';
