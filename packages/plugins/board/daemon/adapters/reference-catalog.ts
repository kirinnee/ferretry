import type {
  ReferenceCatalogEntry,
  ReferenceCatalogInput,
  ReferenceCatalogProvider,
} from '@ferretry/plugin-conversation/contract';
import { referenceCatalogLimit } from '@ferretry/plugin-conversation/contract';
import { type CardView, cap, type LaneCategory } from '../../contract/index.ts';
import type { LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to answer the `&` menu: every card's view with the lanes of each board (`sweepBoard`). */
export interface BoardCardViews {
  sweepBoard(): Promise<{ readonly views: readonly CardView[]; readonly laneSets: LaneSets }>;
}

/** The detail a card with no assignee prints (today's `&` menu row). */
const UNASSIGNED = 'unassigned';

/** The longest an alias is (the entry schema's own bound). */
const MAX_ALIAS = 64;

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

const laneOf = (view: CardView, laneSets: LaneSets) =>
  laneSets.get(view.projectId)?.lanes.find(lane => lane.id === view.laneId);

/** Closed work: dropped, or sitting in a closed-category lane. Known to a proof, not offered by the menu. */
const isClosed = (view: CardView, category: LaneCategory | undefined): boolean =>
  view.dropped !== null || category === 'closed';

/** Work in progress: an active or review lane. The menu lists it first. */
const isActive = (category: LaneCategory | undefined): boolean => category === 'active' || category === 'review';

const touchedMs = (view: CardView): number => {
  const parsed = Date.parse(view.lastTouchedAt ?? view.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

interface Row {
  readonly view: CardView;
  readonly entry: ReferenceCatalogEntry;
  readonly closed: boolean;
  readonly active: boolean;
  readonly haystack: string;
}

/**
 * Open cards first, then closed ones, so the entry bound drops closed work before live work; within each, active
 * work first, then the most recently touched, then id so a re-read never reshuffles equals (today's `compareTasks`).
 */
const compareRows = (left: Row, right: Row): number =>
  Number(left.closed) - Number(right.closed) ||
  Number(right.active) - Number(left.active) ||
  touchedMs(right.view) - touchedMs(left.view) ||
  left.view.id.localeCompare(right.view.id);

/**
 * THE `&` MENU OF ONE FERRET'S COMPOSER (reference.catalog, key `&`): the cards the ferret owns or is assigned, which is
 * today's `sessionCards` slice of the board. The row reads as it did: the token is the card id, the label its title, the
 * detail its assignee (or `unassigned`); the lane and the card's summary are the other words it is found by. A done or
 * dropped card is `closed` (known, so `&F12` still proves, but not offered until its id is typed).
 *
 * Who asked for a card is NOT in an entry (the contract has no field for it), so the "Include agent tasks" switch has
 * nothing to filter by: GAP(board), declared in Conversation's NEEDS-APP-SHELL.txt. Dropping agent cards here instead
 * would make `&F12` of a helper's card stop proving, which is worse.
 *
 * The demand is the one `GET /v1/board` declares (`fleet` use), because it reads the same cards; Conversation asks it
 * of the caller before `entries` runs and refuses exactly as that route would. An entry carries card text and ids only.
 */
export class BoardReferenceCatalog implements ReferenceCatalogProvider {
  readonly demand = cap('fleet', 'use');

  constructor(private readonly board: BoardCardViews) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const { views, laneSets } = await this.board.sweepBoard();
    const needle = (input.query ?? '').trim().toLowerCase();
    const rows: Row[] = [];
    for (const view of views) {
      if (view.owner !== input.ferret && view.assignee !== input.ferret) continue;
      const lane = laneOf(view, laneSets);
      const closed = isClosed(view, lane?.category);
      const laneName = lane?.name ?? view.laneId;
      const aliases = [clip(laneName, MAX_ALIAS), clip(view.summary, MAX_ALIAS)].filter(alias => alias.length > 0);
      const detail = view.assignee ?? UNASSIGNED;
      rows.push({
        view,
        closed,
        active: isActive(lane?.category),
        haystack: [view.id, view.title, view.summary, laneName, view.assignee ?? ''].join('\n').toLowerCase(),
        entry: {
          token: view.id,
          label: clip(view.title, 256),
          detail,
          ...(aliases.length === 0 ? {} : { aliases }),
          ...(closed ? { closed: true } : {}),
        },
      });
    }
    return rows
      .filter(row => needle === '' || row.haystack.includes(needle))
      .sort(compareRows)
      .slice(0, referenceCatalogLimit('&'))
      .map(row => row.entry);
  }
}
