/**
 * What the Warden needs the owner for, as the Warden page reads it — a THIN READ of the Warden's own open
 * notifications, and nothing else.
 *
 * ═══ ONE LIST ═══
 *
 * Every time the Warden needs the owner it sends a plain notification from "Warden" (`escalation.ts`),
 * which the owner reads in the Inbox with every machine's. This view lists exactly those, read back from
 * the same boards, so the Warden page can only point at them, never disagree with them: there is no
 * second account of an ask here — no synthetic row for an anomaly nothing raised, no held action that is
 * not a notification, no verdict joined in after the fact. A ferret's own Attention is not the Warden's,
 * and is not listed.
 *
 * ═══ "NOTHING WAITS" HAS FOUR MEANINGS ═══
 *
 * - `items` — notifications are open; the Warden needs the owner.
 * - `clean-sweep` — a sweep ran, every board read cleanly, nothing waits.
 * - `degraded` — something could not be read (a board, the reports, the sweep is overdue, every warden
 *   account is exhausted), so one may be MISSING. Never a clean all-clear.
 * - `no-sweep` — nothing has run yet; we simply do not know.
 *
 * Pure: the clock arrives as `now`; everything else arrives as arguments.
 */

import type {
  WardenAttentionOutcome,
  WardenAttentionView,
  FleetAttentionItem as WireFleetAttentionItem,
} from '@ferretry/protocol';
import { isWardenEscalationItem, parseWardenEscalationSourceRef } from './escalation.ts';
import { instantMs, isoFromMs } from './time.ts';
import { isTerminalStatus, type WardenSessionStatus } from './types.ts';

/** One row of a session's attention board, as this view reads it. */
export interface AttentionItem {
  readonly id: string;
  readonly source: 'task' | 'question' | 'agent-raised';
  readonly subject: string;
  readonly why: string;
  readonly context?: string;
  readonly waitingSince: string;
  readonly howToResolve: string;
  readonly raisedBy: 'human' | 'agent' | 'daemon';
  /** The item's identity; a Warden notification's is `warden:ask:…`. */
  readonly sourceRef?: string;
}

/** One session's parsed board, as the adapter hands it over. */
export interface AttentionBoardInput {
  readonly sessionId: string;
  readonly parseErrors: number;
  readonly items: readonly AttentionItem[];
}

/** The minimal session shape the view reads. */
export interface FleetSessionLike {
  readonly config: { readonly id: string; readonly teammate?: string; readonly label?: string };
  readonly state: { readonly status?: WardenSessionStatus };
}

export interface WardenAttentionInput {
  /** Wall-clock milliseconds, injected so the builder stays deterministic. */
  readonly now: number;
  readonly sessions: readonly FleetSessionLike[];
  readonly boards: readonly AttentionBoardInput[];
  /** Live sessions whose board could not be read at all: a notification on one of them is hidden. */
  readonly unreadBoards?: number;
  /** The Warden's reports could not be read, so the last sweep raised and cleared nothing. */
  readonly reportsUnreadable?: boolean;
  readonly lastSweepAt?: string;
  /** Set while EVERY warden account is ineligible, so no investigation can run. */
  readonly exhaustedSince?: string;
  /** Sweep cadence; a sweep older than three times this reads as degraded. */
  readonly sweepIntervalMinutes?: number;
}

/** The size the wire's verdict window reports. The view joins no verdicts, so it is never truncated. */
export const WARDEN_ATTENTION_VERDICT_LIMIT = 100;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
const STALE_SWEEP_MULTIPLE = 3;

/** Who every Warden notification reads as raised by. */
const WARDEN_AUTHOR_NAME = 'Warden';

const sortableMs = (value: string | undefined): number => instantMs(value) ?? 0;

export function buildWardenAttentionView(input: WardenAttentionInput): WardenAttentionView {
  const sessionsById = new Map(input.sessions.map(session => [session.config.id, session]));
  const items: WireFleetAttentionItem[] = [];
  for (const board of input.boards) {
    const session = sessionsById.get(board.sessionId);
    // A finished ferret's notification is cleared by the next sweep; it is never the owner's to act on now.
    if (session?.state.status !== undefined && isTerminalStatus(session.state.status)) continue;
    for (const item of board.items) {
      if (!isWardenEscalationItem({ ...item, sourceRef: item.sourceRef ?? null })) continue;
      const identity = parseWardenEscalationSourceRef(item.sourceRef);
      items.push({
        sessionId: board.sessionId,
        ...(session?.config.teammate === undefined ? {} : { teammate: session.config.teammate }),
        ...(session?.config.label === undefined ? {} : { label: session.config.label }),
        ...(session?.state.status === undefined ? {} : { sessionStatus: session.state.status }),
        id: item.id,
        source: item.source,
        subject: item.subject,
        why: item.why,
        ...(item.context === undefined ? {} : { context: item.context }),
        waitingSince: item.waitingSince,
        howToResolve: item.howToResolve,
        raisedBy: 'daemon',
        raisedByName: WARDEN_AUTHOR_NAME,
        ...(identity === undefined ? {} : { anomalyKind: identity.kind }),
      });
    }
  }

  // Oldest waiting first, with a deterministic tie-break so the order is stable between polls.
  const ordered = items.toSorted(
    (left, right) =>
      sortableMs(left.waitingSince) - sortableMs(right.waitingSince) ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.id.localeCompare(right.id),
  );

  const boardsWithParseErrors = input.boards
    .filter(board => board.parseErrors > 0)
    .map(board => ({ sessionId: board.sessionId, parseErrors: board.parseErrors }));

  const intervalMinutes = input.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES;
  const lastSweep = instantMs(input.lastSweepAt);
  const sweepStale = lastSweep !== undefined && input.now - lastSweep > intervalMinutes * STALE_SWEEP_MULTIPLE * 60_000;
  const wardenDegraded = degradedBanner({
    ...(input.exhaustedSince === undefined ? {} : { exhaustedSince: input.exhaustedSince }),
    ...(input.lastSweepAt === undefined ? {} : { lastSweepAt: input.lastSweepAt }),
    sweepStale,
    reportsUnreadable: input.reportsUnreadable === true,
    unreadableBoards: boardsWithParseErrors.length > 0 || (input.unreadBoards ?? 0) > 0,
  });

  // An unreadable board can HIDE a notification, so a sweep that could not read one and shows nothing must not
  // read as a clean all-clear. `no-sweep` stays reserved for "nothing ran at all".
  const outcome: WardenAttentionOutcome =
    ordered.length > 0
      ? 'items'
      : wardenDegraded !== undefined
        ? 'degraded'
        : input.lastSweepAt === undefined
          ? 'no-sweep'
          : 'clean-sweep';

  return {
    generatedAt: isoFromMs(input.now),
    ...(input.lastSweepAt === undefined ? {} : { lastSweepAt: input.lastSweepAt }),
    outcome,
    ...(wardenDegraded === undefined ? {} : { wardenDegraded }),
    items: ordered,
    boardsWithParseErrors,
    verdictCoverage: { limit: WARDEN_ATTENTION_VERDICT_LIMIT, truncated: false },
  };
}

function degradedBanner(evidence: {
  readonly exhaustedSince?: string;
  readonly lastSweepAt?: string;
  readonly sweepStale: boolean;
  readonly reportsUnreadable: boolean;
  readonly unreadableBoards: boolean;
}): WardenAttentionView['wardenDegraded'] {
  if (evidence.exhaustedSince !== undefined)
    return {
      since: evidence.exhaustedSince,
      reason: 'All warden accounts are exhausted — new investigations are paused.',
    };
  if (evidence.sweepStale)
    return {
      ...(evidence.lastSweepAt === undefined ? {} : { since: evidence.lastSweepAt }),
      reason: 'Warden sweeps are overdue — what is listed may be out of date.',
    };
  if (evidence.reportsUnreadable)
    return { reason: 'The Warden’s reports could not be read — a notification for you may be missing.' };
  if (evidence.unreadableBoards)
    return { reason: 'Some agendas could not be read — a notification for you may be hidden.' };
  return undefined;
}
