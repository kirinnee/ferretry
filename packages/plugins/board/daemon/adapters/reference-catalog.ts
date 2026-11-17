import type {
  ReferenceCatalogEntry,
  ReferenceCatalogInput,
  ReferenceCatalogProvider,
} from '@ferretry/plugin-conversation/contract';
import { referenceCatalogLimit } from '@ferretry/plugin-conversation/contract';
import { type TaskView, cap, type LaneCategory } from '../../contract/index.ts';
import type { LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to answer the `&` menu: every task's view with the lanes of each board (`sweepBoard`). */
export interface BoardTaskViews {
  sweepBoard(): Promise<{ readonly views: readonly TaskView[]; readonly laneSets: LaneSets }>;
}

/** The detail a task with no assignee prints (today's `&` menu row). */
const UNASSIGNED = 'unassigned';

/** The longest an alias is (the entry schema's own bound). */
const MAX_ALIAS = 64;

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

const laneOf = (view: TaskView, laneSets: LaneSets) =>
  laneSets.get(view.projectId)?.lanes.find(lane => lane.id === view.laneId);

/** Closed work: dropped, or sitting in a closed-category lane. Known to a proof, not offered by the menu. */
const isClosed = (view: TaskView, category: LaneCategory | undefined): boolean =>
  view.dropped !== null || category === 'closed';

/** Work in progress: an active or review lane. The menu lists it first. */
const isActive = (category: LaneCategory | undefined): boolean => category === 'active' || category === 'review';

/**
 * Whether the ask behind a task was an agent's, not the owner's: TODAY'S rule (the `&` menu's "Include agent tasks"
 * switch), read from the task's own facts and never guessed from its text. The daemon's `askedBy: person` or
 * `origin: human` is the owner's; `origin: agent` or `askedBy: agent` is an agent's; a view that carries neither
 * falls back to "the owner raised it" (`createdBy`), as the app's `isMine` reads it.
 */
const isAgentAsked = (view: TaskView): boolean => {
  if (view.askedBy === 'person' || view.origin === 'human') return false;
  if (view.origin === 'agent' || view.askedBy === 'agent') return true;
  return view.createdBy.kind !== 'owner';
};

const touchedMs = (view: TaskView): number => {
  const parsed = Date.parse(view.lastTouchedAt ?? view.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

interface Row {
  readonly view: TaskView;
  readonly entry: ReferenceCatalogEntry;
  readonly closed: boolean;
  readonly active: boolean;
  readonly haystack: string;
}

/**
 * Open tasks first, then closed ones, so the entry bound drops closed work before live work; within each, active
 * work first, then the most recently touched, then id so a re-read never reshuffles equals (today's `compareTasks`).
 */
const compareRows = (left: Row, right: Row): number =>
  Number(left.closed) - Number(right.closed) ||
  Number(right.active) - Number(left.active) ||
  touchedMs(right.view) - touchedMs(left.view) ||
  left.view.id.localeCompare(right.view.id);

/**
 * THE `&` MENU OF ONE FERRET'S COMPOSER (reference.catalog, key `&`): the tasks the ferret owns or is assigned, which is
 * today's `sessionCards` slice of the board. The row reads as it did: the token is the task id, the label its title, the
 * detail its assignee (or `unassigned`); the lane and the task's summary are the other words it is found by. A done or
 * dropped task is `closed` (known, so `&F12` still proves, but not offered until its id is typed).
 *
 * An entry says who asked: `agentAsked: true` when a ferret or the daemon asked for the task (the task's own
 * `askedBy` / `origin`), omitted when the owner did. The composer's "Include agent tasks" switch filters by it and
 * still offers the task when its id is typed, so `&F12` of a helper's task proves either way: no task is dropped here.
 *
 * The demand is the one `GET /v1/board` declares (`fleet` use), because it reads the same tasks; Conversation asks it
 * of the caller before `entries` runs and refuses exactly as that route would. An entry carries card text and ids only.
 */
export class BoardReferenceCatalog implements ReferenceCatalogProvider {
  readonly demand = cap('fleet', 'use');

  constructor(private readonly board: BoardTaskViews) {}

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
          ...(isAgentAsked(view) ? { agentAsked: true } : {}),
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
