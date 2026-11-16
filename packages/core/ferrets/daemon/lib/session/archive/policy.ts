/**
 * WHICH ENDED SESSIONS LEAVE THE LIVE SET (docs/session-archive.md).
 *
 * A pure decision: it is handed what each session is and the facts that make one worth keeping, and answers
 * which may be archived now. It reads no file and asks no port, so the rule is the same on a first pass over
 * two thousand sessions and on the hourly one after it.
 *
 * THE RULE, in order — a session is archived only when ALL of these hold, and "when unsure, keep it" is the
 * tie-break for everything else:
 *
 * 1. It is AUTONOMOUS: `mode: 'auto'`, the same fact the app's Agents filter and the agenda's clear use. A
 *    session a person drove is never touched, whatever its age.
 * 2. It has ENDED (`completed`, `failed`, `stalled`, `stopped`) and says WHEN (`finishedAt`). An ended
 *    session with no instant is kept: its age is not known.
 * 3. It ended at least `afterMs` ago.
 * 4. Nothing external keeps it ({@link ArchiveFacts.kept}): a pin, a card still in flight, an open agenda
 *    item. The adapter that knows those facts names the sessions; this rule never learns what they were.
 * 5. Every session that names it as `parent` is itself archived (or archivable in this very pass). A lead
 *    outlives its sub-ferrets in the live set, so a lead's children are never orphaned from it.
 * 6. No live session's lineage is UNKNOWN (its config could not be read, so whose child it is cannot be said).
 *    Until the lineage can be proved, any session might be its lead, so the pass
 *    archives nothing: unknown is never read as "no parent".
 */
import { SESSION_ENDED_STATUSES } from '../../protocol/session-subtree.ts';

/** How long a finished autonomous session stays in the live set: one day. */
export const ARCHIVE_AFTER_MS_DEFAULT = 24 * 60 * 60_000;

/** The most sessions one pass archives, so a first run over a large fleet never holds the loop. */
export const ARCHIVE_PASS_LIMIT_DEFAULT = 200;

/** One live session, as the rule sees it: the four facts it decides on and no others. */
export interface ArchiveSession {
  readonly id: string;
  /** `config.mode`: `auto` for an agent ferret, `interactive` for one a person drives. */
  readonly mode: string | undefined;
  readonly status: string;
  /** `state.finishedAt`, an ISO instant; absent while the session has not finished. */
  readonly finishedAt: string | undefined;
  /** `config.parent`: the lead that started it. */
  readonly parent: string | undefined;
  /** `true` when its config could not be read or its `parent` could not be understood: `parent` then says nothing. */
  readonly parentUnknown?: boolean;
}

export interface ArchiveFacts {
  /** The instant the rule is applied at, in epoch milliseconds. */
  readonly nowMs: number;
  /** How long a session must have been ended. */
  readonly afterMs: number;
  /** Sessions something outside the session itself says must stay live, with why. */
  readonly kept: ReadonlyMap<string, string>;
  /** At most this many ids are answered. */
  readonly limit: number;
}

/** Why one session is not archived, in a word a log line can carry. */
export type ArchiveKeepReason = 'interactive' | 'running' | 'no-end-time' | 'too-recent' | 'kept-by-signal';

export interface ArchiveDecision {
  /** Ids to archive, children before the lead that started them, oldest end first. */
  readonly archive: readonly string[];
  /** Eligible by themselves but past the pass limit: the next pass picks them up. */
  readonly deferred: number;
}

const isEnded = (status: string): boolean => SESSION_ENDED_STATUSES.has(status);

/** Why a session is not eligible on its own, or `undefined` when it is. */
export function selfKeepReason(session: ArchiveSession, facts: ArchiveFacts): ArchiveKeepReason | undefined {
  if (session.mode !== 'auto') return 'interactive';
  if (!isEnded(session.status)) return 'running';
  const finished = session.finishedAt === undefined ? Number.NaN : Date.parse(session.finishedAt);
  if (Number.isNaN(finished)) return 'no-end-time';
  if (facts.nowMs - finished < facts.afterMs) return 'too-recent';
  if (facts.kept.has(session.id)) return 'kept-by-signal';
  return undefined;
}

/** Unknown lineage cannot prove that any possible lead is safe to archive while this session stays live. */
export function unknownLineageBlocks(sessions: readonly ArchiveSession[]): boolean {
  return sessions.some(session => session.parentUnknown === true);
}

/**
 * The live sessions that name `id` as their lead and are not on their way out. A lead may leave only when this is
 * empty — asked at the commit boundary, against the roster as it is then, so a child that revived or appeared after
 * the choice was made keeps its lead live.
 */
export function childrenStaying(
  id: string,
  live: readonly ArchiveSession[],
  leaving: ReadonlySet<string>,
): readonly string[] {
  return live
    .filter(session => session.parent === id && session.id !== id && !leaving.has(session.id))
    .map(session => session.id);
}

/**
 * The sessions to archive now.
 *
 * Children come out before the lead that started them, so cutting the answer at the limit can never leave
 * a lead archived with a child still live. A `parent` that names no live session is no obstacle: it was
 * archived earlier or never existed here.
 */
export function decideArchive(sessions: readonly ArchiveSession[], facts: ArchiveFacts): ArchiveDecision {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.parent === undefined || !byId.has(session.parent) || session.parent === session.id) continue;
    const siblings = children.get(session.parent) ?? [];
    siblings.push(session.id);
    children.set(session.parent, siblings);
  }

  /** Eligible by itself AND with every child eligible. Memoised; a lineage loop answers `false`. */
  const settled = new Map<string, boolean>();
  const walking = new Set<string>();
  const archivable = (id: string): boolean => {
    const known = settled.get(id);
    if (known !== undefined) return known;
    const session = byId.get(id);
    if (session === undefined || walking.has(id)) return false;
    walking.add(id);
    let answer = selfKeepReason(session, facts) === undefined;
    if (answer) for (const child of children.get(id) ?? []) answer = archivable(child) && answer;
    walking.delete(id);
    settled.set(id, answer);
    return answer;
  };

  const finishedAt = (id: string): number => Date.parse(byId.get(id)?.finishedAt ?? '');
  const ordered = sessions
    .filter(session => archivable(session.id))
    .map(session => session.id)
    .sort((left, right) => finishedAt(left) - finishedAt(right) || left.localeCompare(right));

  // Post-order over the eligible lineage: every child is emitted before its lead.
  for (const siblings of children.values())
    siblings.sort((left, right) => finishedAt(left) - finishedAt(right) || left.localeCompare(right));
  const emitted = new Set<string>();
  const out: string[] = [];
  const emit = (id: string): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    for (const child of children.get(id) ?? []) emit(child);
    out.push(id);
  };
  for (const id of ordered) emit(id);
  // Whose child an unreadable session is cannot be said, so nothing can be proved safe to archive until it can.
  if (unknownLineageBlocks(sessions)) return { archive: [], deferred: out.length };
  return { archive: out.slice(0, Math.max(0, facts.limit)), deferred: Math.max(0, out.length - facts.limit) };
}

/** The variable that sets how many hours a finished autonomous session stays live, or `off`. */
export const ARCHIVE_AFTER_VARIABLE = 'FYD_SESSION_ARCHIVE_AFTER_HOURS';

/**
 * The age for this `FYD_SESSION_ARCHIVE_AFTER_HOURS` value, in milliseconds: absent, empty or `off` is
 * `undefined` (nothing is archived), and anything that is not a whole number of hours, one or more, throws naming the
 * variable — so a typo is heard at boot rather than silently archiving at the wrong age.
 */
export function parseArchiveAfter(raw: string | undefined): number | undefined {
  const text = raw?.trim().toLowerCase() ?? '';
  if (text === '' || text === 'off') return undefined;
  if (!/^[1-9]\d*$/u.test(text))
    throw new Error(`${ARCHIVE_AFTER_VARIABLE} must be a whole number of hours (1 or more) or "off": ${raw ?? ''}`);
  return Number(text) * 60 * 60_000;
}
