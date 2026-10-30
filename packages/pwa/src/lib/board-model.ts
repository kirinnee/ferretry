/**
 * THE BOARD, AS PURE DECISIONS: how every paired machine's cards merge into one board, what the page's
 * filters are and how they travel in a URL, what each card is "running on", and whether a move may go.
 *
 * Nothing here reads the network or the clock. `board-client.ts` reads, `board-store.ts` holds, and
 * `hooks/use-board.ts` wires the two; this file is the part a test can drive with plain values.
 *
 * A CARD IS KEYED `(daemonId, taskId)`. A task id (`F412`) is unique on its machine only, so two machines
 * both holding an `F12` are two cards. Every project keeps the lane set of the machine that owns the
 * card, because each daemon may have confirmed its own lanes for what is, to the owner, the same project.
 *
 * LIVENESS IS THE DAEMON'S. `activity`, `lastTouchedAt`, `rollup` and `waitingOnOwner` arrive on the card
 * and are only grouped and counted here — never derived from a clock. The one fact computed in the
 * browser is {@link runningOn}, because only the browser knows every paired daemon's version.
 */

import {
  type BoardActivityFilter,
  BoardActivityFilterSchema,
  type BoardCounts,
  type BoardProjectId,
  BoardProjectIdSchema,
  type BoardPrStateFilter,
  BoardPrStateFilterSchema,
  type BoardQuarantinedCard,
  type BoardResult,
  type BoardStateFilter,
  BoardStateFilterSchema,
  type BoardTaskId,
  type BoardTaskView,
  boardErr,
  boardOk,
  compareProtocolVersions,
  isInBoardState,
  type LaneCategory,
  type LaneSet,
  type MoveReasonProblem,
  moveReasonProblem,
  type ReleasedIn,
  type TaskKind,
  TaskKindSchema,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

// ---------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------

/** Whether one paired machine is running the release a card shipped in. */
export interface RunningOnMachine {
  readonly daemonId: DaemonId;
  readonly machine: string;
  /** The daemon's own version; `null` when it could not be read. */
  readonly version: string | null;
  /** `true` only when its version is known and is at or past the release. */
  readonly has: boolean;
}

/** A card on the merged board: the daemon's view of it, and the machine it lives on. */
interface BoardCard {
  /** `(daemonId, taskId)`, collision-safe: see {@link boardCardKey}. */
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly machine: string;
  readonly task: BoardTaskView;
  /** Empty until the card has shipped in a release. */
  readonly runningOn: readonly RunningOnMachine[];
}

export const boardCardKey = (daemonId: DaemonId, taskId: BoardTaskId): string => JSON.stringify([daemonId, taskId]);

/**
 * Each paired machine's version against the release a card shipped in. A card that has not shipped has
 * no `runningOn`; a machine whose version is unknown, or not comparable, is `has: false` rather than
 * guessed at.
 */
export const runningOn = (
  shippedIn: Pick<ReleasedIn, 'version'> | null,
  machines: readonly { readonly daemonId: DaemonId; readonly machine: string; readonly version: string | null }[],
): readonly RunningOnMachine[] =>
  shippedIn === null
    ? []
    : machines.map(machine => ({
        daemonId: machine.daemonId,
        machine: machine.machine,
        version: machine.version,
        has: machine.version !== null && (compareProtocolVersions(machine.version, shippedIn.version) ?? -1) >= 0,
      }));

// ---------------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------------

/**
 * What the Board's header narrows to. `machine` and `mine` are the browser's own to apply; the rest are
 * the daemon's query (`toServerQuery`).
 */
export interface BoardFilters {
  readonly project: BoardProjectId | null;
  readonly machine: DaemonId | null;
  /** A session id: the cards it owns or is assigned. */
  readonly ferret: string | null;
  readonly kind: TaskKind | null;
  readonly pr: BoardPrStateFilter | null;
  readonly state: BoardStateFilter;
  readonly activity: BoardActivityFilter | null;
  /** The cards the owner created or that wait on the owner. */
  readonly mine: boolean;
}

export const NO_BOARD_FILTERS: BoardFilters = Object.freeze({
  project: null,
  machine: null,
  ferret: null,
  kind: null,
  pr: null,
  state: 'open',
  activity: null,
  mine: false,
});

const nonEmpty = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

/**
 * Reads the filters out of a URL's search string. Total: a value this app does not know is dropped, so
 * a stale or hand-edited link opens the unfiltered board rather than an error.
 */
export const parseBoardFilters = (search: string | URLSearchParams): BoardFilters => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const project = BoardProjectIdSchema.safeParse(nonEmpty(params.get('project')));
  const kind = TaskKindSchema.safeParse(params.get('kind'));
  const pr = BoardPrStateFilterSchema.safeParse(params.get('pr'));
  const state = BoardStateFilterSchema.safeParse(params.get('state'));
  const activity = BoardActivityFilterSchema.safeParse(params.get('activity'));
  const mine = params.get('mine');
  return {
    project: project.success ? project.data : null,
    machine: (nonEmpty(params.get('machine')) as DaemonId | null) ?? null,
    ferret: nonEmpty(params.get('ferret')),
    kind: kind.success ? kind.data : null,
    pr: pr.success ? pr.data : null,
    state: state.success ? state.data : NO_BOARD_FILTERS.state,
    activity: activity.success ? activity.data : null,
    mine: mine === '1' || mine === 'true',
  };
};

/**
 * The URL parameters for a filter set. Defaults are left out (`state=open`, no `mine`), so the plain board
 * has a plain URL and `parseBoardFilters(boardFiltersToSearch(f))` is `f` for every filter set.
 */
export const boardFiltersToSearch = (filters: BoardFilters): URLSearchParams => {
  const params = new URLSearchParams();
  if (filters.project !== null) params.set('project', filters.project);
  if (filters.machine !== null) params.set('machine', filters.machine);
  if (filters.ferret !== null) params.set('ferret', filters.ferret);
  if (filters.kind !== null) params.set('kind', filters.kind);
  if (filters.pr !== null) params.set('pr', filters.pr);
  if (filters.state !== NO_BOARD_FILTERS.state) params.set('state', filters.state);
  if (filters.activity !== null) params.set('activity', filters.activity);
  if (filters.mine) params.set('mine', '1');
  return params;
};

/** The part of the filters the daemon answers: what a read of `/v1/board` is scoped by. */
export interface BoardServerQuery {
  readonly project: BoardProjectId | null;
  readonly ferret: string | null;
  readonly kind: TaskKind | null;
  readonly pr: BoardPrStateFilter | null;
  readonly state: BoardStateFilter;
  readonly activity: BoardActivityFilter | null;
}

export const toServerQuery = (filters: BoardFilters): BoardServerQuery => ({
  project: filters.project,
  ferret: filters.ferret,
  kind: filters.kind,
  pr: filters.pr,
  state: filters.state,
  activity: filters.activity,
});

/** The query parameters of one `GET /v1/board` page (`BoardQuerySchema`'s spelling). */
export const boardQueryParams = (query: BoardServerQuery, cursor?: string, limit?: number): URLSearchParams => {
  const params = new URLSearchParams();
  if (query.project !== null) params.set('project', query.project);
  if (query.ferret !== null) params.set('ferret', query.ferret);
  if (query.kind !== null) params.set('kind', query.kind);
  if (query.pr !== null) params.set('prState', query.pr);
  if (query.activity !== null) params.set('activity', query.activity);
  params.set('state', query.state);
  if (limit !== undefined) params.set('limit', String(limit));
  if (cursor !== undefined) params.set('cursor', cursor);
  return params;
};

/** A stable name for a server query, so two pages asking the same thing share one read. */
export const serverQueryKey = (query: BoardServerQuery): string =>
  JSON.stringify([query.project, query.ferret, query.kind, query.pr, query.state, query.activity]);

/** Whether the owner has a stake in the card: they raised it, or it waits on their answer. */
export const isMine = (task: Pick<BoardTaskView, 'createdBy' | 'waitingOnOwner'>): boolean =>
  task.createdBy.kind === 'owner' || task.waitingOnOwner.length > 0;

const categoryIn = (laneSet: LaneSet | null, task: BoardTaskView): LaneCategory | null =>
  laneSet?.lanes.find(lane => lane.id === task.laneId)?.category ?? null;

const matchesActivity = (filter: BoardActivityFilter, task: BoardTaskView, category: LaneCategory | null): boolean => {
  switch (filter) {
    case 'to_test':
      return category === 'verify';
    case 'waiting_on_you':
      return task.waitingOnOwner.length > 0;
    case 'blocked':
      return task.blockedBy.length > 0;
    default:
      return task.activity === filter;
  }
};

const matchesPr = (filter: BoardPrStateFilter, task: BoardTaskView): boolean => {
  const prs = task.links.prs;
  switch (filter) {
    case 'none':
      return prs.length === 0;
    case 'draft':
      return prs.some(pr => pr.state === 'open' && pr.draft);
    case 'open':
      return prs.some(pr => pr.state === 'open' && !pr.draft);
    case 'ci_red':
      return prs.some(pr => pr.state === 'open' && pr.checks === 'failing');
    case 'merged':
      return prs.some(pr => pr.state === 'merged');
    case 'released':
      return task.shippedIn !== null;
  }
};

/**
 * Whether a card the daemon just sent belongs in a read made with this query. A live update re-reads one
 * card, not the board, so the page must decide for itself whether that card still belongs to the view; it
 * is the same decision the daemon makes, over the same fields, and the periodic re-read corrects any
 * disagreement. It reads the card's derived `activity`; it never works one out.
 */
export const cardMatchesQuery = (task: BoardTaskView, laneSet: LaneSet | null, query: BoardServerQuery): boolean => {
  const category = categoryIn(laneSet, task);
  if (query.project !== null && task.projectId !== query.project) return false;
  if (query.ferret !== null && task.owner !== query.ferret && task.assignee !== query.ferret) return false;
  if (query.kind !== null && task.kind !== query.kind) return false;
  if (category !== null && !isInBoardState(query.state, category, task.dropped !== null)) return false;
  if (category === null && query.state !== 'all' && (task.dropped !== null) !== (query.state === 'dropped')) {
    return false;
  }
  if (query.pr !== null && !matchesPr(query.pr, task)) return false;
  return query.activity === null || matchesActivity(query.activity, task, category);
};

// ---------------------------------------------------------------------------------------------------
// The merged board
// ---------------------------------------------------------------------------------------------------

/** What one machine's read of the board holds. */
export interface BoardMachineData {
  readonly daemonId: DaemonId;
  readonly machine: string;
  readonly version: string | null;
  readonly cards: readonly BoardTaskView[];
  /** This machine's lane set for each project it holds cards for; `null` when it has none confirmed. */
  readonly laneSets: ReadonlyMap<BoardProjectId, LaneSet | null>;
  readonly counts: BoardCounts | null;
  readonly quarantined: readonly BoardQuarantinedCard[];
}

/** One lane of one project's board on one machine. */
interface BoardLane {
  readonly id: string;
  readonly name: string;
  readonly category: LaneCategory;
  readonly cards: readonly BoardCard[];
}

/**
 * One project's board on one machine. The lanes are that machine's own, so a project present on two
 * machines is two boards (the merged view labels each with its machine).
 */
interface BoardGroup {
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly machine: string;
  readonly projectId: BoardProjectId;
  readonly laneSet: LaneSet | null;
  readonly lanes: readonly BoardLane[];
  /** Cards whose lane is not in the lane set (an edit raced the read); never dropped from view. */
  readonly unplaced: readonly BoardCard[];
}

interface BoardQuarantine {
  readonly daemonId: DaemonId;
  readonly machine: string;
  readonly cards: readonly BoardQuarantinedCard[];
}

export interface BoardModel {
  readonly groups: readonly BoardGroup[];
  readonly cards: readonly BoardCard[];
  /** The header's numbers, summed over every machine read. */
  readonly counts: BoardCounts;
  /** Cards a daemon set aside as unreadable, per machine. */
  readonly quarantined: readonly BoardQuarantine[];
  /** More than one machine is in the model: the page shows a machine chip. */
  readonly multiMachine: boolean;
}

const ZERO_COUNTS: BoardCounts = Object.freeze({
  closedHidden: 0,
  stale: 0,
  orphaned: 0,
  active: 0,
  toTest: 0,
  waitingOnYou: 0,
});

const addCounts = (left: BoardCounts, right: BoardCounts): BoardCounts => ({
  closedHidden: left.closedHidden + right.closedHidden,
  stale: left.stale + right.stale,
  orphaned: left.orphaned + right.orphaned,
  active: left.active + right.active,
  toTest: left.toTest + right.toTest,
  waitingOnYou: left.waitingOnYou + right.waitingOnYou,
});

/** The card's place in its lane: ordered cards first (by `order`), then the longest-untouched first. */
const compareCards = (left: BoardCard, right: BoardCard): number => {
  const a = left.task.order;
  const b = right.task.order;
  if (a !== null && b !== null && a !== b) return a - b;
  if (a !== null && b === null) return -1;
  if (a === null && b !== null) return 1;
  const touched = (right.task.lastTouchedAt ?? '').localeCompare(left.task.lastTouchedAt ?? '');
  return touched !== 0 ? touched : left.task.id.localeCompare(right.task.id, undefined, { numeric: true });
};

/**
 * Merges every machine's read into one board: cards keyed `(daemonId, taskId)`, grouped project → lane
 * with each machine's own lane set, counts summed, and `runningOn` set from every machine's version.
 * `machine` and `mine` are applied here; the rest of the filters were the daemon's.
 */
export const mergeBoard = (machines: readonly BoardMachineData[], filters: BoardFilters): BoardModel => {
  const versions = machines.map(({ daemonId, machine, version }) => ({ daemonId, machine, version }));
  const kept = machines.filter(data => filters.machine === null || data.daemonId === filters.machine);
  const groups: BoardGroup[] = [];
  const cards: BoardCard[] = [];
  let counts = ZERO_COUNTS;
  const quarantined: BoardQuarantine[] = [];

  for (const data of kept) {
    if (data.counts !== null) counts = addCounts(counts, data.counts);
    if (data.quarantined.length > 0) {
      quarantined.push({ daemonId: data.daemonId, machine: data.machine, cards: data.quarantined });
    }
    const byProject = new Map<BoardProjectId, BoardCard[]>();
    for (const task of data.cards) {
      if (filters.mine && !isMine(task)) continue;
      const card: BoardCard = {
        key: boardCardKey(data.daemonId, task.id),
        daemonId: data.daemonId,
        machine: data.machine,
        task,
        runningOn: runningOn(task.shippedIn, versions),
      };
      cards.push(card);
      const members = byProject.get(task.projectId);
      if (members === undefined) byProject.set(task.projectId, [card]);
      else members.push(card);
    }
    for (const [projectId, members] of byProject) {
      const laneSet = data.laneSets.get(projectId) ?? null;
      const known = new Set(laneSet?.lanes.map(lane => lane.id));
      groups.push({
        key: JSON.stringify([data.daemonId, projectId]),
        daemonId: data.daemonId,
        machine: data.machine,
        projectId,
        laneSet,
        lanes: (laneSet?.lanes ?? []).map(lane => ({
          id: lane.id,
          name: lane.name,
          category: lane.category,
          cards: members.filter(card => card.task.laneId === lane.id).sort(compareCards),
        })),
        unplaced: members.filter(card => !known.has(card.task.laneId)).sort(compareCards),
      });
    }
  }

  return {
    groups,
    cards,
    counts,
    quarantined,
    multiMachine: kept.length > 1,
  };
};

// ---------------------------------------------------------------------------------------------------
// Moving a card
// ---------------------------------------------------------------------------------------------------

export type MoveCheckProblem = MoveReasonProblem | { readonly code: 'no-lane-set' };

/**
 * Whether a move may be sent: a move back needs a reason, and the lanes must be the project's own. It is
 * the protocol's own rule (`moveReasonProblem`), asked before the request so the page can say so without
 * a round trip; the daemon asks it again and its answer stands.
 */
export const checkMove = (
  laneSet: Pick<LaneSet, 'lanes' | 'variants'> | null,
  from: string,
  to: string,
  reason: string | undefined,
): BoardResult<undefined, MoveCheckProblem> => {
  if (laneSet === null) return boardErr({ code: 'no-lane-set' as const });
  const problem = moveReasonProblem(laneSet, from, to, reason);
  return problem.ok ? boardOk(undefined) : boardErr(problem.error);
};
