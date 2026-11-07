/**
 * THE SIDE PANEL'S AGENDA TAB, as data: four filters over one agenda board (docs/agenda.md § The side panel's Agenda
 * tab). Pure and total — nothing here draws.
 *
 * Every filter's count IS the length of its row list: the counts are read off the lists, never computed beside them,
 * so the chip and the list cannot disagree. The order of each list is the protocol's own selector, so the Inbox, the
 * badge and this tab say the same thing in the same order:
 *
 * - Needs you — `needsYouQueue`: each item once, blockers first, then by when it started needing the owner.
 * - Resting — `restingQueue` without the snoozed: waiting on the ferret first, then the ferret working.
 * - Snoozed — `restingQueue`'s snoozed tail: by wake time.
 * - Resolved — newest resolution first.
 *
 * A plain notification is read, never answered, so it is on none of the four.
 */

import {
  type AgendaItem,
  type AgendaStage,
  agendaStage,
  agendaState,
  hasOpenCardAsk,
  needsYouQueue,
  type AgendaListRecord,
  restingQueue,
} from '../wire/index.ts';
import { shortAgo } from './agenda-revisions.ts';
import { agendaAuthor, parkedUntilWords } from './agenda-status.ts';

export type AgendaTabFilter = 'needs-you' | 'resting' | 'snoozed' | 'resolved';

export const AGENDA_TAB_FILTERS: readonly AgendaTabFilter[] = ['needs-you', 'resting', 'snoozed', 'resolved'];

const AGENDA_TAB_FILTER_LABEL: Readonly<Record<AgendaTabFilter, string>> = {
  'needs-you': 'Needs you',
  resting: 'Resting',
  snoozed: 'Snoozed',
  resolved: 'Resolved',
};

export const AGENDA_TAB_EMPTY: Readonly<Record<AgendaTabFilter, string>> = {
  'needs-you': 'Nothing needs you.',
  resting: 'Nothing is resting.',
  snoozed: 'Nothing is snoozed.',
  resolved: 'Nothing has been resolved.',
};

const STAGE_LABEL: Readonly<Record<AgendaStage, string>> = {
  explainer: 'Explainer',
  question: 'Question',
  plan: 'Plan to approve',
  tracker: 'Tracker',
  test: 'Test',
  done: 'Done',
};

export interface AgendaTabRow {
  readonly id: AgendaItem['id'];
  readonly filter: AgendaTabFilter;
  readonly item: AgendaItem | AgendaListRecord;
  /** "Needs you", "Resting · waiting on Johnnie", "Resting · working", "Snoozed until Thu 09:00", "Done". */
  readonly state: string;
  /** A blocker, drawn first in Needs you and marked there. */
  readonly blocking: boolean;
  /** What the agenda is right now: "Question", "Plan to approve", "Tracker", "Test"; the last one a resolved item had. */
  readonly stage: string;
  /** Since the state began, in the fewest characters ("3m ago"); `null` when the instant cannot be read. */
  readonly since: string | null;
}

export interface AgendaTabModel {
  readonly rows: Readonly<Record<AgendaTabFilter, readonly AgendaTabRow[]>>;
  /** The chips: one per filter, each count the length of that filter's rows. */
  readonly chips: readonly { readonly key: AgendaTabFilter; readonly label: string; readonly count: number }[];
}

export interface AgendaTabInput {
  readonly items: readonly AgendaItem[];
  readonly resolved: readonly AgendaListRecord[];
  /** The ferret's spoken name, for "waiting on Johnnie". */
  readonly ferret: string;
  readonly now: number;
}

/**
 * The stage an item had before it closed. The daemon writes `stage: done` on a close and keeps every earlier stage in
 * `stages`, so a closed item names its last stage that was not `done`; one that never named a stage reads from its kind.
 */
const lastUsefulStage = (item: AgendaItem | AgendaListRecord): AgendaStage => {
  if (item.stage !== undefined && item.stage !== 'done') return item.stage;
  const earlier = [...(item.stages ?? [])].reverse().find(entry => entry.stage !== 'done');
  return earlier?.stage ?? agendaStage({ kind: item.kind, ask: item.ask });
};

const isBlocker = (item: AgendaItem): boolean => item.blockingNow === true || hasOpenCardAsk(item);

const sinceWords = (instant: string | undefined, now: number): string | null => {
  if (instant === undefined) return null;
  const words = shortAgo(instant, now);
  return words === '' ? null : words;
};

export const agendaTabModel = ({ items, resolved, ferret, now }: AgendaTabInput): AgendaTabModel => {
  const open = items.filter(item => item.notice !== true);
  const stageOf = (item: AgendaItem | AgendaListRecord): string => STAGE_LABEL[lastUsefulStage(item)];
  const row = (
    filter: AgendaTabFilter,
    item: AgendaItem | AgendaListRecord,
    state: string,
    since: string | undefined,
  ): AgendaTabRow => ({
    id: item.id,
    filter,
    item,
    state,
    blocking: filter === 'needs-you' && isBlocker(item as AgendaItem),
    stage: stageOf(item),
    since: sinceWords(since, now),
  });

  const needsYou = needsYouQueue(open).map(item => row('needs-you', item, 'Needs you', item.waitingSince));
  const rested = restingQueue(open).map(item => {
    const view = agendaState(item);
    if (view.state === 'resting')
      return row(
        'resting',
        item,
        view.sub === 'working' ? 'Resting · working' : `Resting · waiting on ${agendaAuthor(item, ferret)}`,
        view.since,
      );
    // `restingQueue` contains only resting and snoozed items.
    const until = parkedUntilWords(item, now);
    return row('snoozed', item, until === null ? 'Snoozed' : `Snoozed until ${until}`, item.parked?.at);
  });
  const resolvedRows = [...resolved]
    .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
    .map(item => row('resolved', item, 'Done', item.resolvedAt));

  const rows: Record<AgendaTabFilter, readonly AgendaTabRow[]> = {
    'needs-you': needsYou,
    resting: rested.filter(each => each.filter === 'resting'),
    snoozed: rested.filter(each => each.filter === 'snoozed'),
    resolved: resolvedRows,
  };
  return {
    rows,
    chips: AGENDA_TAB_FILTERS.map(key => ({ key, label: AGENDA_TAB_FILTER_LABEL[key], count: rows[key].length })),
  };
};

/** The four counts in one line for Overview: "2 need you · 1 resting · 0 snoozed · 5 resolved". */
export const agendaSummary = (counts: Readonly<Record<AgendaTabFilter, number>>): string =>
  `${String(counts['needs-you'])} ${counts['needs-you'] === 1 ? 'needs' : 'need'} you · ${String(counts.resting)} resting · ${String(counts.snoozed)} snoozed · ${String(counts.resolved)} resolved`;
