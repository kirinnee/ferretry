import { type SessionStatus, SessionStatusSchema } from '@ferretry/protocol';

/**
 * The statuses that end a session for good.
 *
 * A session is ingested on a DURABLE TERMINAL STATE, never on a guess that it looks finished. Two
 * pieces of evidence are required together — a recorded finish instant and one of these statuses —
 * because each alone is satisfied by a session that is still going:
 *
 * - A finish instant with a live status is a session the daemon stamped and then kept running, or one
 *   whose two documents were written out of order. Its duration is not final.
 * - A terminal status with no finish instant is a session whose end nobody recorded. Measuring it
 *   would put a duration of zero on the board, and a zero is a measurement rather than a gap.
 *
 * `kill_failed` is DELIBERATELY ABSENT even though it reads like an ending. It means the daemon asked
 * the runtime to end the session and could not confirm that it did, so the process may still be
 * spending tokens. Ingesting it would freeze a running session's totals as its final ones.
 */
export const TERMINAL_ANALYTICS_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'completed',
  'failed',
  'stalled',
  'stopped',
]);

/** Why a session the daemon holds a record for is not ingestable analytics evidence. */
export type AnalyticsIngestRefusal =
  /** No finish instant is recorded, so the run has no measurable end. */
  | 'no_finish_instant'
  /** A finish instant was recorded but is not an instant this daemon can read. */
  | 'unreadable_finish_instant'
  /** No creation instant is recorded, so the run has no measurable start and no day or week. */
  | 'no_creation_instant'
  /** A creation instant was recorded but is not an instant this daemon can read. */
  | 'unreadable_creation_instant'
  /** The status does not end a session, so its totals are not final. */
  | 'nonterminal_status'
  /** The status is absent or is not a status this daemon models, so terminality is unprovable. */
  | 'unknown_status';

/**
 * A passed gate carries the evidence it accepted, rather than leaving the caller to re-read the
 * optional fields it just proved. That is what keeps the ingest path free of assertions: the record
 * builder is handed instants that are known to be readable instead of values it must insist upon.
 */
export type AnalyticsIngestGate =
  | {
      readonly kind: 'ingest';
      readonly status: SessionStatus;
      readonly createdAt: string;
      readonly finishedAt: string;
    }
  | { readonly kind: 'refused'; readonly reason: AnalyticsIngestRefusal };

/**
 * The state evidence the gate judges. Every field is optional-shaped because it comes from documents
 * on disk that may be absent, half-written or from an older layout.
 */
export interface AnalyticsIngestEvidence {
  readonly createdAt?: string | null;
  readonly finishedAt?: string | null;
  readonly status?: string | null;
}

function readableInstant(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && Number.isFinite(Date.parse(value));
}

/**
 * The status as one of the values this daemon models, or `null`.
 *
 * PARSED against the protocol's own enum rather than string-compared, so a status from an older
 * layout or a typo in a hand-edited document is `unknown_status` — a state the daemon cannot judge —
 * instead of being lumped in with a session that is genuinely still running.
 */
function knownStatus(value: string | null | undefined): SessionStatus | null {
  const parsed = SessionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether one session may enter the analytics index yet.
 *
 * DAMAGED STATE IS NOT EMPTY STATE. Every rejection here names what was missing rather than reporting
 * the session as an unremarkable zero-length run, because a caller shown a fleet of zero-cost
 * sessions has been given a wrong answer, not a missing one. The distinction is also what makes a
 * later pass correct: a session refused for want of a finish instant is refused AGAIN, and ingested
 * the moment its end is recorded, whereas a session ingested early would keep whatever partial
 * totals it happened to have when the daemon looked.
 */
export function gateAnalyticsIngest(evidence: AnalyticsIngestEvidence): AnalyticsIngestGate {
  const status = knownStatus(evidence.status);
  if (status === null) return { kind: 'refused', reason: 'unknown_status' };
  if (!TERMINAL_ANALYTICS_STATUSES.has(status)) return { kind: 'refused', reason: 'nonterminal_status' };
  const { createdAt, finishedAt } = evidence;
  if (finishedAt === null || finishedAt === undefined) return { kind: 'refused', reason: 'no_finish_instant' };
  if (!readableInstant(finishedAt)) return { kind: 'refused', reason: 'unreadable_finish_instant' };
  if (createdAt === null || createdAt === undefined) return { kind: 'refused', reason: 'no_creation_instant' };
  if (!readableInstant(createdAt)) return { kind: 'refused', reason: 'unreadable_creation_instant' };
  return { kind: 'ingest', status, createdAt, finishedAt };
}
