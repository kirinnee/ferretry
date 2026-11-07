/**
 * THE BOARD PAGE (`/board`): every card on the machine as lanes.
 *
 * It owns what the views must not: the reads (the U10 board store, once per kind of read) and the filters in
 * the URL. The page is READ-ONLY for the owner: no drag between lanes, no lane menu, no "Add card", no
 * "Lanes ✎" editor link — the board runs itself and the owner answers in the agenda. What stays are the
 * reading aids: the view switch, the filters, "Show private", the scope toggle and the theme switch. Everything
 * drawn is `BoardCard`, `BoardLane`, `BoardCountsBar` and `BoardFilterBar`, which the phone and the side pane reuse.
 */

import type { BoardActivityFilter, BoardProjectId } from '../../contract/index.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '@ferretry/app/ui';
import { useBoard, useBoardFilters, useBoardProjects, type BoardMachine } from '../hooks/use-board.ts';
import { useNow } from '@ferretry/app/ui';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonId, FerretScope } from '../lib/machine.ts';
import { type BoardFilters, boardFiltersToSearch, NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { ferretNamer } from '../lib/board-present.ts';
import {
  archivePage,
  archiveRows,
  BOARD_VIEW_LABEL,
  BOARD_VIEWS,
  type BoardGroupOf,
  type BoardViewId,
  cardPlaces,
  laneNames,
  parseBoardView,
} from '../lib/board-view.ts';
import { boardCardPath, boardPath } from '../lib/paths.ts';
import { BoardCountsBar } from './board-counts.tsx';
import { DEFAULT_SUMMARY_WINDOW, parseSummaryWindow, type SummaryWindow } from '../lib/board-summary.ts';
import { BoardFilterBar, BoardFilterSheet } from './board-filters.tsx';
import { BoardNotice } from './board-notice.tsx';
import { PhoneKanban } from './board-phone.tsx';
import { BoardDetail } from './detail/board-detail.tsx';
import { TableView } from './board-table.tsx';
import { ArchiveView, type BoardCardEnv, DependenciesView, KanbanView, TreeView } from './board-views.tsx';

export interface BoardPageProps {
  readonly store: DaemonBoardStore;
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
  /** The card the address names (`/d/<id>/board/<taskId>`); it opens as a drawer, or a page on a phone. */
  readonly openCard?: { readonly daemonId: DaemonId; readonly taskId: string } | null;
  /** A phone: one lane at a time under a chip strip, the filters in a bottom sheet, rows sized for a thumb. */
  readonly phone?: boolean;
  /**
   * The chat the reader came from. When there is one the page opens on THAT ferret's cards, with a one-tap
   * "All cards" to widen it; a ferret or "All cards" choice in the URL always wins.
   */
  readonly origin?: FerretScope | null;
}

const NO_MACHINES: readonly BoardMachine[] = [];

/** "This ferret | All cards": the one-tap widening of a board that opened on the chat the reader came from. */
function ScopeToggle({
  ferret,
  scoped,
  onChange,
}: {
  readonly ferret: string;
  readonly scoped: boolean;
  /** True to widen to every card, false to narrow back to the ferret. */
  readonly onChange: (all: boolean) => void;
}) {
  return (
    <fieldset aria-label="Which cards" className="fy-board__scope" data-board-scope={scoped ? 'ferret' : 'all'}>
      <button
        aria-pressed={scoped}
        className="fy-board__scope-option"
        data-scope="ferret"
        onClick={() => onChange(false)}
        title={`Only ${ferret}'s cards`}
        type="button"
      >
        {ferret}
      </button>
      <button
        aria-pressed={!scoped}
        className="fy-board__scope-option"
        data-scope="all"
        onClick={() => onChange(true)}
        type="button"
      >
        All cards
      </button>
    </fieldset>
  );
}

export function BoardPage({
  store,
  machines,
  callsigns,
  search,
  onSearch,
  onNavigate,
  now: fixedNow,
  openCard = null,
  phone = false,
  origin = null,
}: BoardPageProps) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // The ferret the page opens on: the chat's, unless the URL names a ferret or asked for every card.
  const scopeFerret = origin?.ferret ?? null;
  const defaultScoped = scopeFerret !== null && params.get('cards') !== 'all' && params.get('ferret') === null;
  const filterSearch = useMemo(() => {
    if (!defaultScoped) return search;
    const next = new URLSearchParams(search);
    next.set('ferret', scopeFerret);
    return next.toString();
  }, [defaultScoped, scopeFerret, search]);
  const view = parseBoardView(params.get('view'));
  const window = parseSummaryWindow(params.get('window'));
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
      for (const key of ['view', 'window', 'at']) {
        const kept = params.get(key);
        if (kept !== null) next.set(key, kept);
      }
      // Dropping the ferret is a choice that has to stick, or the default would bring it straight back.
      if (scopeFerret !== null) {
        if (next.get('ferret') === null) next.set('cards', 'all');
        else next.delete('cards');
      }
      writeParams(next);
    },
    [params, scopeFerret, writeParams],
  );
  const [filters, setFilters] = useBoardFilters(filterSearch, writeFilters);
  const scoped = scopeFerret !== null && filters.ferret === scopeFerret;
  const setView = (next: BoardViewId): void => {
    const nextParams = new URLSearchParams(params);
    if (next === 'kanban') nextParams.delete('view');
    else nextParams.set('view', next);
    writeParams(nextParams);
  };
  const setLane = (laneId: string): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('at', laneId);
    writeParams(nextParams);
  };
  const setWindow = (next: SummaryWindow): void => {
    const nextParams = new URLSearchParams(params);
    if (next === DEFAULT_SUMMARY_WINDOW) nextParams.delete('window');
    else nextParams.set('window', next);
    writeParams(nextParams);
  };

  // The page's own read: what is open. The Archive keeps it for the header's numbers.
  const openFilters = useMemo<BoardFilters>(
    () => (archive ? { ...filters, state: 'open' } : filters),
    [archive, filters],
  );
  const board = useBoard(store, machines, openFilters);
  // The Archive's two extra reads; an empty machine list reads nothing.
  const wantClosed = (archive && filters.state !== 'dropped') || view === 'list';
  const wantDropped = archive && filters.state !== 'closed';
  const closedFilters = useMemo<BoardFilters>(() => ({ ...filters, state: 'closed' }), [filters]);
  const droppedFilters = useMemo<BoardFilters>(() => ({ ...filters, state: 'dropped' }), [filters]);
  const closed = useBoard(store, wantClosed ? machines : NO_MACHINES, closedFilters);
  const dropped = useBoard(store, wantDropped ? machines : NO_MACHINES, droppedFilters);

  const connections = useMemo(() => machines.map(machine => machine.connection), [machines]);
  const projects = useBoardProjects(store, connections);
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

  // A phone can dismiss a machine's error; it comes back if the machine says something else.
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());

  // ----- what the views are given -------------------------------------------------------------------
  const env = useMemo<BoardCardEnv>(
    () => ({
      names,
      now,
      showMachine: model.multiMachine || machines.length > 1,
      touch: phone,
      hrefFor: card => boardCardPath(card.daemonId, card.task.id),
      onNavigate,
      places,
    }),
    [names, now, model.multiMachine, machines.length, onNavigate, places, phone],
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

  const detailMachine =
    openCard === null ? undefined : machines.find(machine => machine.connection.daemonId === openCard.daemonId);
  // The open card's sub-cards are in its detail whether or not the board shows them, open or closed: a read of its
  // machine with every state and every sub-card in, which only an open card pays for.
  const detailMachines = useMemo(() => (detailMachine === undefined ? NO_MACHINES : [detailMachine]), [detailMachine]);
  const detailFilters = useMemo<BoardFilters>(() => ({ ...NO_BOARD_FILTERS, state: 'all', agents: true }), []);
  const detailRead = useBoard(store, detailMachines, detailFilters, { beat: false });
  const detailPlaces = useMemo(() => cardPlaces(detailRead.model), [detailRead.model]);
  const siblings = useMemo(
    () =>
      openCard === null
        ? []
        : detailRead.model.cards
            .filter(card => card.daemonId === openCard.daemonId)
            .map(card => ({
              task: card.task,
              laneName: detailPlaces.get(card.key)?.laneName ?? card.task.laneId,
              runningOn: card.runningOn,
            })),
    [detailRead.model.cards, detailPlaces, openCard],
  );
  const closeDetail = useCallback(() => {
    if (openCard !== null) onNavigate(boardPath(openCard.daemonId));
  }, [openCard, onNavigate]);

  // A count pressed on a phone opens the matching cards as a list (pressed again, it lifts the filter).
  const pressCount = (activity: BoardActivityFilter | null): void => {
    if (!phone || activity === null) {
      setFilters({ ...filters, activity });
      return;
    }
    const next = boardFiltersToSearch({ ...filters, activity });
    next.set('view', 'list');
    writeParams(next);
  };

  const scopeToggle =
    scopeFerret === null ? null : (
      <ScopeToggle
        ferret={names(scopeFerret)}
        onChange={all => setFilters({ ...filters, ferret: all ? null : scopeFerret })}
        scoped={scoped}
      />
    );
  // `?highlight=F11` (Info's "Open board"): the card is marked and scrolled to, and the mark follows it through refreshes.
  const highlight = params.get('highlight');
  const pageRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `model` is the trigger — a refresh redraws the cards, so the mark is laid again
  useEffect(() => {
    const page = pageRef.current;
    if (page === null || highlight === null || highlight === '') return;
    const cards = [...page.querySelectorAll<HTMLElement>('[data-task]')].filter(
      card => card.dataset['task'] === highlight,
    );
    for (const card of cards) card.setAttribute('data-highlighted', '');
    cards[0]?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    return () => {
      for (const card of cards) card.removeAttribute('data-highlighted');
    };
  }, [highlight, model]);

  const hideClosed = filters.state === 'open';
  const reading = board.status === 'loading' || board.status === 'idle';
  const failed = board.status === 'error';

  return (
    <section aria-label="Board" className="fy-board" data-phone={phone ? '' : undefined} data-view={view} ref={pageRef}>
      <header className="fy-board__head">
        {phone ? null : <h1 className="fy-board__title">Board</h1>}
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
        {phone ? null : <div className="fy-board__tools">{scopeToggle}</div>}
      </header>
      {phone ? (
        <div className="fy-board__phone-bar">
          <BoardFilterSheet
            archive={archive}
            choices={choices}
            filters={filters}
            onChange={next => setFilters(next)}
            quietFerret={scopeFerret}
            splitsAgents={model.splitsAgents}
          />
          {scopeToggle}
          <BoardCountsBar
            activity={filters.activity}
            counts={model.counts}
            onActivity={pressCount}
            onOpenArchive={() => setView('archive')}
          />
        </div>
      ) : (
        <>
          <BoardCountsBar
            activity={filters.activity}
            counts={model.counts}
            onActivity={pressCount}
            onOpenArchive={() => setView('archive')}
          />
          <BoardFilterBar
            archive={archive}
            choices={choices}
            defaultOpen={false}
            filters={filters}
            onChange={next => setFilters(next)}
            quietFerret={scopeFerret}
            splitsAgents={model.splitsAgents}
          />
        </>
      )}
      {board.machines
        .filter(machine => machine.status === 'error')
        .map(machine => {
          const said = `${machine.machine} did not answer: ${machine.error ?? 'unreachable'}`;
          const key = `${machine.daemonId}:${said}`;
          if (dismissedErrors.has(key)) return null;
          return (
            <BoardNotice
              compact={phone}
              key={machine.daemonId}
              machine={machine.daemonId}
              onDismiss={phone ? () => setDismissedErrors(current => new Set(current).add(key)) : undefined}
            >
              {said}
            </BoardNotice>
          );
        })}
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
        ) : phone ? (
          <PhoneKanban
            at={params.get('at')}
            env={env}
            hideClosed={hideClosed}
            model={model}
            onLane={setLane}
            projectName={projectName}
          />
        ) : (
          <KanbanView env={env} hideClosed={hideClosed} model={model} projectName={projectName} />
        )
      ) : view === 'list' ? (
        <TableView closed={closed.model} env={env} model={model} onWindow={setWindow} window={window} />
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
      {openCard === null || detailMachine === undefined ? null : (
        <BoardDetail
          machine={detailMachine}
          names={names}
          now={now}
          onClose={closeDetail}
          onNavigate={onNavigate}
          phone={phone}
          projectName={id => projectNames.get(id) ?? id.slice(0, 8)}
          siblings={siblings}
          store={store}
          taskId={openCard.taskId}
        />
      )}
    </section>
  );
}
