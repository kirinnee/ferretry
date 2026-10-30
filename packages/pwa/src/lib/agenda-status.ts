/**
 * WHERE AN AGENDA ITEM STANDS, as one pure decision every surface shares (the row, the full card, the Inbox):
 * whose turn it is and what it blocks, as the one pill a reader scans. A plain notification has no turn and so
 * no status. Nothing here draws anything.
 */

import { type AttentionItem, type AttentionTurn, attentionTurn } from '@ferretry/protocol';

type AgendaTone = 'blocking' | 'needs-you' | 'will-block' | 'needed-by' | 'ferret' | 'done';

export interface AgendaStatus {
  readonly turn: AttentionTurn;
  readonly tone: AgendaTone;
  /** The pill's words: "Blocking now", "Needs you", "Will block: the deploy", "Needed by 17:00", "With Johnnie". */
  readonly label: string;
  /** A deadline said beside a pill that is not itself the deadline. */
  readonly deadline: string | null;
  /** The deadline has passed while the item still waits on the owner. */
  readonly overdue: boolean;
  /** A ferret's-turn or finished item reads quieter than one that needs the owner. */
  readonly dimmed: boolean;
}

type Timed = Pick<AttentionItem, 'neededBy'>;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY = 86_400_000;

const two = (value: number): string => String(value).padStart(2, '0');
const startOfDay = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** A deadline as a person says it: "17:00" today, "tomorrow 09:30", "Thu 17:00" within the week, else "5 Nov 17:00". */
export const clockWords = (instant: string, now: number): string | null => {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(new Date(now))) / DAY);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[at.getDay()]} ${time}`;
  return `${String(at.getDate())} ${MONTHS[at.getMonth()]} ${time}`;
};

/** "Needed by 17:00", or `null` when there is no deadline (or it cannot be read). */
export const neededByWords = (item: Timed, now: number): string | null => {
  if (item.neededBy === undefined) return null;
  const words = clockWords(item.neededBy, now);
  return words === null ? null : `Needed by ${words}`;
};

const isNotice = (item: Pick<AttentionItem, 'notice'>): boolean => item.notice === true;

/** The status of one item; `null` for a plain notification, which has no turn. `ferret` is the ferret's name. */
export const agendaStatus = (item: AttentionItem, ferret: string, now = Date.now()): AgendaStatus | null => {
  if (isNotice(item)) return null;
  const turn = attentionTurn(item);
  const deadline = neededByWords(item, now);
  const overdue = turn === 'owner' && item.neededBy !== undefined && Date.parse(item.neededBy) < now;
  if (turn === 'done') return { turn, tone: 'done', label: 'Done', deadline: null, overdue: false, dimmed: true };
  if (turn === 'ferret')
    return { turn, tone: 'ferret', label: `With ${ferret}`, deadline: null, overdue: false, dimmed: true };
  const base = { turn, overdue, dimmed: false } as const;
  if (item.blockingNow === true) return { ...base, tone: 'blocking', label: 'Blocking now', deadline };
  if (item.willBlock !== undefined && item.willBlock.trim() !== '')
    return { ...base, tone: 'will-block', label: `Will block: ${item.willBlock.trim()}`, deadline };
  if (deadline !== null) return { ...base, tone: 'needed-by', label: deadline, deadline: null };
  return { ...base, tone: 'needs-you', label: 'Needs you', deadline: null };
};

const RANK: Readonly<Record<AgendaTone, number>> = {
  blocking: 0,
  'needed-by': 1,
  'will-block': 2,
  'needs-you': 3,
  ferret: 4,
  done: 5,
};

/** Notifications sort with the plain "needs you" items, after everything that blocks or is due. */
const rankOf = (item: AttentionItem): number =>
  isNotice(item) ? RANK['needs-you'] : RANK[(agendaStatus(item, '') as AgendaStatus).tone];

const deadlineOf = (item: AttentionItem): number => {
  const at = item.neededBy === undefined ? Number.NaN : Date.parse(item.neededBy);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
};

/**
 * The agenda's order: blocking now, then what is due (the nearest deadline first), then what will block, then
 * what plainly needs the owner (the one that has waited longest first), then what is with the ferret, then what is
 * done. Returns a new array.
 */
export const sortAgenda = (items: readonly AttentionItem[]): readonly AttentionItem[] =>
  [...items].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      deadlineOf(a) - deadlineOf(b) ||
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.id.localeCompare(b.id),
  );

/** The item to open after one is answered: the next in `ordered` that is still the owner's turn, wrapping round. */
export const nextOwnerItem = (ordered: readonly AttentionItem[], from: AttentionItem['id']): AttentionItem | null => {
  const start = ordered.findIndex(item => item.id === from);
  for (let step = 1; step <= ordered.length; step += 1) {
    const candidate = ordered[(start + step + ordered.length) % ordered.length];
    if (candidate !== undefined && candidate.id !== from && attentionTurn(candidate) === 'owner') return candidate;
  }
  return null;
};

/** Who raised it, in a word: "Warden" for the daemon's own Warden, otherwise the ferret that raised it. */
export const agendaAuthor = (item: Pick<AttentionItem, 'raisedBy' | 'sourceRef'>, ferret: string): string =>
  item.raisedBy === 'daemon' && (item.sourceRef ?? '').startsWith('warden:') ? 'Warden' : ferret;
