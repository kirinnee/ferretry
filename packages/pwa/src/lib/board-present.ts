/**
 * WHAT A BOARD CARD SAYS, AS PLAIN VALUES.
 *
 * A card face is two lines (`board-design.md` §4.0): the title, and one meta line made of short
 * SEGMENTS — `&F412 · owner→assignee · ● 4m · PR ✓ · ⛓ 2 · subs 2/3`. This file decides which segments
 * a card has and what each one says; the component only draws them. Nothing here reads the clock (the
 * caller passes `now`) or the network, so every state of a card can be driven with plain values.
 *
 * LIVENESS IS THE DAEMON'S: `activity` arrives on the card and is only worded here. The one exception
 * the page honours is the To test lane — a card there waits for the OWNER, so it is never worded as
 * stale or idle, whatever the daemon derived.
 */

import { type BoardTaskView, formatTaskRef, type LaneCategory, type PrLink } from '@ferretry/protocol';
import { displayCallsign } from './callsign.ts';

/** How a segment is coloured; `quiet` is the plain meta text. */
type BoardTone = 'quiet' | 'ok' | 'warn' | 'err' | 'pend' | 'accent';

/** The glyph a segment or count wears: the card draws it from the app's icon set, so no emoji font is needed. */
export type BoardIconName =
  | 'active'
  | 'to-test'
  | 'stale'
  | 'waiting-on-you'
  | 'waiting'
  | 'orphaned'
  | 'blocked'
  | 'subs'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-draft'
  | 'pr-pass'
  | 'pr-fail'
  | 'pr-pending';

export interface BoardSegment {
  /** Stable per kind, so a test and a style can name one. */
  readonly key: 'ref' | 'people' | 'activity' | 'pr' | 'blocked' | 'subs' | 'shipped' | 'machine';
  readonly text: string;
  /** Drawn before the text, or `null`. */
  readonly icon: BoardIconName | null;
  readonly tone: BoardTone;
  /** The full sentence behind the short text, for a tooltip and a screen reader. */
  readonly title: string;
  /** Dropped from the compact (`side`) density, which keeps one short line. */
  readonly optional: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `now`, `4m`, `2h`, `3d`: the coarsest unit that is at least one. `null` when there is no instant. */
export const ageLabel = (instant: string | null, now: number): string | null => {
  if (instant === null) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
};

/** A session's short name: its callsign, else the start of its id. */
export type FerretNames = (sessionId: string) => string;

const SHORT_ID = 8;

export const fallbackFerretName = (sessionId: string): string => sessionId.slice(0, SHORT_ID);

/** Names every ferret by its callsign from `known`, else by the start of its id. */
export const ferretNamer =
  (known: ReadonlyMap<string, string>): FerretNames =>
  sessionId => {
    const callsign = displayCallsign(known.get(sessionId));
    return callsign === '' ? fallbackFerretName(sessionId) : callsign;
  };

export const peopleLabel = (task: Pick<BoardTaskView, 'owner' | 'assignee'>, names: FerretNames): string => {
  const owner = names(task.owner);
  return task.assignee === null || task.assignee === task.owner ? owner : `${owner}→${names(task.assignee)}`;
};

const activitySegment = (task: BoardTaskView, category: LaneCategory | null, now: number): BoardSegment => {
  const age = ageLabel(task.lastTouchedAt, now);
  const make = (text: string, icon: BoardIconName | null, tone: BoardTone, title: string): BoardSegment => ({
    key: 'activity',
    text,
    icon,
    tone,
    title,
    optional: false,
  });
  if (category === 'verify') return make('to test', 'to-test', 'accent', 'Waiting for you to try it');
  switch (task.activity) {
    case 'active':
      return make(age === null ? 'active' : age, 'active', 'ok', 'A ferret is working on it now');
    case 'idle':
      return make(age === null ? 'idle' : `idle ${age}`, null, 'quiet', 'Nobody is working on it right now');
    case 'stale':
      return make(
        age === null ? 'stale' : `stale ${age}`,
        'stale',
        'warn',
        'Idle for longer than its lane allows. Nudge it or move it.',
      );
    case 'waiting':
      return task.waitingOnOwner.length > 0
        ? make('waiting on you', 'waiting-on-you', 'warn', 'A ferret is stopped until you answer')
        : make('waiting', 'waiting', 'pend', 'Waiting on something outside the ferret');
    case 'orphaned':
      return make('orphaned', 'orphaned', 'err', 'No ferret is left on it. Start one.');
  }
};

/** The PR the card face names: an open one first, else the newest merged one, else the last linked. */
export const headlinePr = (prs: readonly PrLink[]): PrLink | null => {
  if (prs.length === 0) return null;
  const open = prs.find(pr => pr.state === 'open');
  if (open !== undefined) return open;
  const merged = prs
    .filter(pr => pr.state === 'merged')
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
  return merged[0] ?? prs[prs.length - 1] ?? null;
};

const prSegment = (prs: readonly PrLink[]): BoardSegment | null => {
  const pr = headlinePr(prs);
  if (pr === null) return null;
  const more = prs.length > 1 ? ` +${prs.length - 1}` : '';
  const make = (text: string, icon: BoardIconName | null, tone: BoardTone, title: string): BoardSegment => ({
    key: 'pr',
    text: `${text}${more}`,
    icon,
    tone,
    title: `${title} (${pr.repo}#${pr.number})`,
    optional: false,
  });
  if (pr.state === 'merged') return make('PR', 'pr-merged', 'ok', 'Merged');
  if (pr.state === 'closed') return make('PR', 'pr-closed', 'quiet', 'Closed without merging');
  if (pr.draft) return make('PR', 'pr-draft', 'quiet', 'A draft PR');
  if (pr.checks === 'failing') return make('PR', 'pr-fail', 'err', 'CI is red');
  if (pr.checks === 'pending') return make('PR', 'pr-pending', 'pend', 'CI is running');
  if (pr.checks === 'passing') return make('PR', 'pr-pass', 'ok', 'CI is green');
  return make('PR', null, 'quiet', 'A PR is linked');
};

/** How many of the children are finished: closed ones, of those not dropped. */
export const subsDone = (task: Pick<BoardTaskView, 'rollup'>): number => task.rollup.byCategory.closed;

export interface SegmentContext {
  readonly names: FerretNames;
  readonly now: number;
  /** The category of the lane the card sits in; `null` when its lane is unknown. */
  readonly category: LaneCategory | null;
  /** The machine's name, set only when more than one machine is on the board. */
  readonly machine: string | null;
}

/** The meta line of a card, left to right. */
export const cardSegments = (task: BoardTaskView, context: SegmentContext): readonly BoardSegment[] => {
  const segments: BoardSegment[] = [
    {
      key: 'ref',
      text: formatTaskRef({ id: task.id }),
      icon: null,
      tone: 'quiet',
      title: `${task.kind} ${formatTaskRef({ id: task.id })}`,
      optional: false,
    },
    {
      key: 'people',
      text: peopleLabel(task, context.names),
      icon: null,
      tone: 'quiet',
      title: `Owned by ${context.names(task.owner)}${
        task.assignee === null || task.assignee === task.owner ? '' : `, assigned to ${context.names(task.assignee)}`
      }`,
      optional: true,
    },
    activitySegment(task, context.category, context.now),
  ];
  const pr = prSegment(task.links.prs);
  if (pr !== null) segments.push(pr);
  if (task.blockedBy.length > 0) {
    segments.push({
      key: 'blocked',
      text: String(task.blockedBy.length),
      icon: 'blocked',
      tone: 'warn',
      title: `Blocked by ${task.blockedBy.map(ref => formatTaskRef(ref)).join(', ')}`,
      optional: false,
    });
  }
  if (task.rollup.children > 0) {
    segments.push({
      key: 'subs',
      text: `${subsDone(task)}/${task.rollup.children}`,
      icon: 'subs',
      tone: task.rollup.active > 0 ? 'ok' : 'quiet',
      title: `${subsDone(task)} of ${task.rollup.children} sub-tasks are closed, ${task.rollup.active} working now`,
      optional: false,
    });
  }
  if (task.shippedIn !== null) {
    segments.push({
      key: 'shipped',
      text: `in ${task.shippedIn.version}`,
      icon: null,
      tone: 'accent',
      title: `Shipped in ${task.shippedIn.version}`,
      optional: true,
    });
  }
  if (context.machine !== null) {
    segments.push({
      key: 'machine',
      text: context.machine,
      icon: null,
      tone: 'quiet',
      title: `On ${context.machine}`,
      optional: true,
    });
  }
  return segments;
};
