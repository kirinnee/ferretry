/**
 * THE BOARD PAGE (`/d/<id>/board`): every task on every paired machine as lanes.
 *
 * It owns what the views must not: the reads (the U10 board store, once per kind of read), the filters in
 * the URL, the drag in the air and the move flow. A move forward is sent as dropped; a move BACK opens a
 * one-line reason box and is sent only with it. Everything drawn is `BoardCard`, `BoardLane`,
 * `BoardCountsBar` and `BoardFilterBar`, which the phone and the side pane reuse.
 */

import type { BoardProjectId } from '@ferretry/protocol';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import {
  useBoard,
  useBoardActions,
  useBoardFilters,
  useBoardProjects,
  type BoardMachine,
} from '../../hooks/use-board.ts';
import type { DaemonAgendaClient } from '../../lib/agenda-client.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import type { BoardFilters } from '../../lib/board-model.ts';
import { moveChoices, planMove } from '../../lib/board-move.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import {
  archivePage,
  archiveRows,
  BOARD_VIEW_LABEL,
  BOARD_VIEWS,
  type BoardCardOf,
  type BoardCardPlace,
  type BoardGroupOf,
  type BoardViewId,
  cardPlaces,
  laneNames,
  laneOfCategory,
  parseBoardView,
  parseListSort,
} from '../../lib/board-view.ts';
import { daemonBoardCardPath, daemonProjectLanesPath } from '../../lib/pages/routes.ts';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import type { BoardCardMoves } from './board-card.tsx';
import { BoardCountsBar } from './board-counts.tsx';
import { BoardFilterBar } from './board-filters.tsx';
import { BoardReasonBox } from './board-reason-box.tsx';
import { ArchiveView, type BoardCardEnv, DependenciesView, KanbanView, ListView, TreeView } from './board-views.tsx';

export interface BoardPageProps {
  readonly store: DaemonBoardStore;
  readonly agenda: Pick<DaemonAgendaClient, 'respond'>;
  /** Every paired machine, in the order the shell shows them. */
  readonly machines: readonly BoardMachine[];
  /** Ferret callsigns by session id; a ferret not listed is named by the start of its id. */
  readonly callsigns: ReadonlyMap<string, string>;
  /** The URL's query string, with or without the leading `?`. */
  readonly search: string;
  /** Writes a new query string (no `?`) to the URL; the filters and the view live there. */
  readonly onSearch: (search: string) => void;
  readonly onNavigate: (to: string) => void;
  /** A fixed clock for the age labels; the live page re-reads the time every 30 seconds. */
  readonly now?: number;
  /** Starts the filters folded: a narrow screen opens them from the "Filters" button. */
  readonly compact?: boolean;
}

interface PendingMove {
  readonly card: BoardCardOf;
  readonly group: BoardGroupOf;
  readonly to: string;
  readonly toName: string;
}

const useNow = (fixed: number | undefined): number => {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
};

const NO_MACHINES: readonly BoardMachine[] = [];

export function BoardPage({
  store,
  agenda,
  machines,
  callsigns,
  search,
  onSearch,
  onNavigate,
  now: fixedNow,
  compact = false,
}: BoardPageProps) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const view = parseBoardView(params.get('view'));
  const sort = parseListSort(params.get('sort'));
  const archive = view === 'archive';

  const writeParams = useCallback(
    (next: URLSearchParams) => {
      onSearch(next.toString());
    },
    [onSearch],
  );
  const writeFilters = useCallback(
    (filterSearch: string) => {
      const next = new URLSearchParams(filterSearch);
      for (const key of ['view', 'sort']) {
        const kept = params.get(key);
        if (kept !== null) next.set(key, kept);
      }
      writeParams(next);
    },
    [params, writeParams],
  );
  const [filters, setFilters] = useBoardFilters(search, writeFilters);
  const setView = (next: BoardViewId): void => {
    const nextParams = new URLSearchParams(params);
    if (next === 'kanban') nextParams.delete('view');
    else nextParams.set('view', next);
    writeParams(nextParams);
  };
  const setSort = (next: string): void => {
    const nextParams = new URLSearchParams(params);
    if (next === 'stale') nextParams.delete('sort');
    else nextParams.set('sort', next);
    writeParams(nextParams);
  };

  // The page's own read: what is open. The Archive keeps it for the header's numbers.
  const openFilters = useMemo<BoardFilters>(
    () => (archive ? { ...filters, state: 'open' } : filters),
    [archive, filters],
  );
  const board = useBoard(store, machines, openFilters);
  // The Archive's two extra reads; an empty machine list reads nothing.
  const wantClosed = archive && filters.state !== 'dropped';
  const wantDropped = archive && filters.state !== 'closed';
  const closedFilters = useMemo<BoardFilters>(() => ({ ...filters, state: 'closed' }), [filters]);
  const droppedFilters = useMemo<BoardFilters>(() => ({ ...filters, state: 'dropped' }), [filters]);
  const closed = useBoard(store, wantClosed ? machines : NO_MACHINES, closedFilters);
  const dropped = useBoard(store, wantDropped ? machines : NO_MACHINES, droppedFilters);

  const connections = useMemo(() => machines.map(machine => machine.connection), [machines]);
  const projects = useBoardProjects(store, connections);
  const actions = useBoardActions(store, agenda, connections);
  const now = useNow(fixedNow);
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);

  const projectNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const state of projects.values())
      for (const project of state.projects ?? []) byId.set(project.id, project.name);
    return byId;
  }, [projects]);
  const projectName = useCallback(
    (group: BoardGroupOf): string => projectNames.get(group.projectId) ?? group.projectId.slice(0, 8),
    [projectNames],
  );

  const model = board.model;
  const places = useMemo(() => {
    if (!archive) return cardPlaces(model);
    return new Map([...cardPlaces(closed.model), ...cardPlaces(dropped.model)]);
  }, [archive, model, closed.model, dropped.model]);

  // ----- moving -------------------------------------------------------------------------------------
  const [dragging, setDragging] = useState<{ cardKey: string; groupKey: string } | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const send = useCallback(
    async (card: BoardCardOf, group: BoardGroupOf, to: string, reason?: string): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      const result = await actions.moveTask(
        { daemonId: card.daemonId, id: card.task.id, laneId: card.task.laneId, laneSet: group.laneSet },
        to,
        reason,
      );
      setBusy(false);
      if (result.ok) return true;
      setProblem(result.error.message);
      return false;
    },
    [actions],
  );

  const requestMove = useCallback(
    (card: BoardCardOf, group: BoardGroupOf, laneId: string): void => {
      const plan = planMove(group.laneSet, card.task.laneId, laneId);
      setNotice(null);
      if (plan.kind === 'refused') {
        setNotice(plan.message);
        return;
      }
      if (plan.kind === 'ask-reason') {
        const toName = group.laneSet?.lanes.find(lane => lane.id === plan.to)?.name ?? plan.to;
        setProblem(null);
        setPending({ card, group, to: plan.to, toName });
        return;
      }
      if (plan.kind === 'send') {
        void send(card, group, plan.to).then(ok => {
          if (!ok) setNotice('The move did not go through.');
        });
      }
    },
    [send],
  );

  const movesFor = useCallback(
    (card: BoardCardOf, place: BoardCardPlace): BoardCardMoves | undefined => {
      const { group } = place;
      if (group.laneSet === null || place.category === 'closed') return undefined;
      return {
        choices: moveChoices(group.laneSet, card.task.laneId),
        onMove: (target, laneId) => requestMove(target, group, laneId),
        closeLaneId: laneOfCategory(group, 'closed'),
        reworkLaneId: laneOfCategory(group, 'active', 'last'),
        onDragStart: target => setDragging({ cardKey: target.key, groupKey: group.key }),
        onDragEnd: () => setDragging(null),
      };
    },
    [requestMove],
  );

  const onDropCard = useCallback(
    (groupKey: string, laneId: string): void => {
      const air = dragging;
      setDragging(null);
      if (air === null || air.groupKey !== groupKey) return;
      const group = model.groups.find(candidate => candidate.key === groupKey);
      const card = model.cards.find(candidate => candidate.key === air.cardKey);
      if (group === undefined || card === undefined) return;
      requestMove(card, group, laneId);
    },
    [dragging, model, requestMove],
  );

  const submitReason = async (reason: string): Promise<void> => {
    if (pending === null) return;
    const ok = await send(pending.card, pending.group, pending.to, reason);
    if (ok) setPending(null);
  };

  // ----- what the views are given -------------------------------------------------------------------
  const env = useMemo<BoardCardEnv>(
    () => ({
      names,
      now,
      showMachine: model.multiMachine || machines.length > 1,
      hrefFor: card => daemonBoardCardPath(card.daemonId, card.task.id),
      onNavigate,
      movesFor: archive ? () => undefined : movesFor,
      places,
      dragging,
    }),
    [names, now, model.multiMachine, machines.length, onNavigate, archive, movesFor, places, dragging],
  );

  const [archiveQuery, setArchiveQuery] = useState('');
  const [archivePages, setArchivePages] = useState(1);
  const archiveAll = useMemo(
    () => archiveRows([...closed.model.cards, ...dropped.model.cards], archiveQuery),
    [closed.model.cards, dropped.model.cards, archiveQuery],
  );
  const archiveShown = archivePage(archiveAll, archivePages);

  const choices = useMemo(() => {
    const ferrets = new Map<string, string>();
    for (const card of model.cards) {
      for (const id of [card.task.owner, card.task.assignee]) {
        if (id !== null && !ferrets.has(id)) ferrets.set(id, names(id));
      }
    }
    return {
      projects: [...projects.values()]
        .flatMap(state => state.projects ?? [])
        .filter((project, index, all) => all.findIndex(other => other.id === project.id) === index)
        .map(project => ({ id: project.id as BoardProjectId, name: project.name })),
      machines: machines.map(machine => ({ daemonId: machine.connection.daemonId, name: machine.name })),
      ferrets: [...ferrets].map(([id, name]) => ({ id, name })),
      lanes: laneNames(model),
    };
  }, [model, projects, machines, names]);

  const editLanes = useCallback(
    (group: BoardGroupOf): void => onNavigate(daemonProjectLanesPath(group.daemonId, group.projectId)),
    [onNavigate],
  );
  const onlyGroup = model.groups.length === 1 ? model.groups[0] : undefined;

  const hideClosed = filters.state === 'open';
  const reading = board.status === 'loading' || board.status === 'idle';
  const failed = board.status === 'error';

  return (
    <section aria-label="Board" className="fy-board" data-view={view}>
      <header className="fy-board__head">
        <h1 className="fy-board__title">Board</h1>
        <nav aria-label="Board views" className="fy-board__views">
          {BOARD_VIEWS.map(option => (
            <button
              aria-current={view === option ? 'page' : undefined}
              className="fy-board__view"
              data-view-tab={option}
              key={option}
              onClick={() => setView(option)}
              type="button"
            >
              {BOARD_VIEW_LABEL[option]}
            </button>
          ))}
        </nav>
        <div className="fy-board__tools">
          {onlyGroup === undefined ? null : (
            <button
              className="fy-board__lanes"
              data-board-lanes="header"
              onClick={() => editLanes(onlyGroup)}
              type="button"
            >
              Lanes ✎
            </button>
          )}
          <PageThemeSwitch />
        </div>
      </header>
      <BoardCountsBar
        activity={filters.activity}
        counts={model.counts}
        onActivity={activity => setFilters({ ...filters, activity })}
        onOpenArchive={() => setView('archive')}
      />
      <BoardFilterBar
        archive={archive}
        choices={choices}
        defaultOpen={!compact}
        filters={filters}
        onChange={next => setFilters(next)}
      />
      {notice === null ? null : (
        <p className="fy-board__notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss" className="fy-board__notice-x" onClick={() => setNotice(null)} type="button">
            <X aria-hidden="true" size={12} />
          </button>
        </p>
      )}
      {board.machines
        .filter(machine => machine.status === 'error')
        .map(machine => (
          <p className="fy-board__notice" data-machine={machine.daemonId} key={machine.daemonId} role="status">
            {machine.machine} did not answer: {machine.error ?? 'unreachable'}
          </p>
        ))}
      {reading && model.cards.length === 0 ? (
        <p className="fy-board__reading" role="status">
          <Spinner size={14} />
          Reading the board…
        </p>
      ) : failed ? (
        <p className="fy-board__empty" role="alert">
          The board could not be read.{' '}
          <button className="fy-board__retry" onClick={board.refresh} type="button">
            Try again
          </button>
        </p>
      ) : view === 'kanban' ? (
        model.groups.length === 0 ? (
          <p className="fy-board__empty">No project has a board yet.</p>
        ) : (
          <KanbanView
            env={env}
            hideClosed={hideClosed}
            model={model}
            onDropCard={onDropCard}
            onEditLanes={editLanes}
            projectName={projectName}
          />
        )
      ) : view === 'list' ? (
        <ListView env={env} model={model} onSort={setSort} sort={sort} />
      ) : view === 'tree' ? (
        <TreeView env={env} model={model} />
      ) : view === 'dependencies' ? (
        <DependenciesView env={env} model={model} />
      ) : (
        <ArchiveView
          env={env}
          loading={closed.status === 'loading' || dropped.status === 'loading'}
          onMore={() => setArchivePages(pages => pages + 1)}
          onQuery={query => {
            setArchiveQuery(query);
            setArchivePages(1);
          }}
          query={archiveQuery}
          remaining={archiveShown.remaining}
          shown={archiveShown.shown}
          total={archiveAll.length}
        />
      )}
      {pending === null ? null : (
        <div className="fy-board__scrim">
          <BoardReasonBox
            busy={busy}
            error={problem}
            heading={`Move ${pending.card.task.title} back to ${pending.toName}`}
            onCancel={() => {
              setPending(null);
              setProblem(null);
            }}
            onSubmit={reason => void submitReason(reason)}
          />
        </div>
      )}
    </section>
  );
}
