/**
 * THE BOARD PAGE (`/d/<id>/board`): every task on every paired machine as lanes.
 *
 * It owns what the views must not: the reads (the U10 board store, once per kind of read), the filters in
 * the URL, the drag in the air and the move flow. A move forward is sent as dropped; a move BACK opens the
 * send-back composer (the words, and pictures where the machine takes them) and is sent only with its words.
 * Each card's answer in flight is tracked here, so the pressed button spins, the card's other answers wait,
 * and a refusal is said on the card it belongs to. Everything drawn is `BoardCard`, `BoardLane`,
 * `BoardCountsBar` and `BoardFilterBar`, which the phone and the side pane reuse.
 */

import type { BoardActivityFilter, BoardProjectId } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import {
  useBoard,
  useBoardActions,
  useBoardFilters,
  useBoardProjects,
  type BoardMachine,
} from '../../hooks/use-board.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { type BoardFilters, boardFiltersToSearch } from '../../lib/board-model.ts';
import { boardDone, doneLaneOf, isReleaseLane, notGoodLaneOf } from '../../lib/board-done.ts';
import { moveChoices } from '../../lib/board-move.ts';
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
  parseBoardView,
} from '../../lib/board-view.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath, daemonBoardPath, daemonProjectLanesPath } from '../../lib/pages/routes.ts';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import type { BoardCardMoves } from './board-card.tsx';
import { BoardCountsBar } from './board-counts.tsx';
import { DEFAULT_SUMMARY_WINDOW, parseSummaryWindow, type SummaryWindow } from '../../lib/board-summary.ts';
import { BoardFilterBar, BoardFilterSheet } from './board-filters.tsx';
import { BoardNotice } from './board-notice.tsx';
import { PhoneKanban } from './board-phone.tsx';
import { useBoardAnswers } from './board-answers.tsx';
import type { SendBackPorts } from './board-send-back.tsx';
import { type BoardAgenda, BoardDetail, type BoardDetailPorts } from './detail/board-detail.tsx';
import { BoardNewCard, type NewCardPorts } from './detail/board-new-card.tsx';
import { TableView } from './board-table.tsx';
import {
  ArchiveView,
  type BoardCardEnv,
  type BoardDoneControl,
  DependenciesView,
  KanbanView,
  TreeView,
} from './board-views.tsx';

export interface BoardPageProps {
  readonly store: DaemonBoardStore;
  readonly agenda: Pick<BoardAgenda, 'respond'> & Partial<Pick<BoardAgenda, 'hydrate' | 'store'>>;
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
  /** Speaking to ferrets and starting one; without them the detail cannot comment and there is no "+ Card". */
  readonly ports?: BoardDetailPorts & NewCardPorts & SendBackPorts;
  /** A phone: one lane at a time under a chip strip, the filters in a bottom sheet, rows sized for a thumb. */
  readonly phone?: boolean;
  /**
   * The chat the reader came from. When there is one the page opens on THAT ferret's cards, with a one-tap
   * "All cards" to widen it; a ferret or "All cards" choice in the URL always wins.
   */
  readonly origin?: DaemonSessionScope | null;
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
  agenda,
  machines,
  callsigns,
  search,
  onSearch,
  onNavigate,
  now: fixedNow,
  openCard = null,
  ports,
  phone = false,
  origin = null,
}: BoardPageProps) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // The ferret the page opens on: the chat's, unless the URL names a ferret or asked for every card.
  const scopeFerret = origin?.sessionId ?? null;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // A phone can dismiss a machine's error; it comes back if the machine says something else.
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());

  const { requestMove, answerFor, composer } = useBoardAnswers({
    actions,
    ports,
    connectionOf: daemonId => machines.find(machine => machine.connection.daemonId === daemonId)?.connection,
    phone,
    onNotice: setNotice,
  });

  const movesFor = useCallback(
    (card: BoardCardOf, place: BoardCardPlace): BoardCardMoves | undefined => {
      const { group } = place;
      if (group.laneSet === null || place.category === 'closed') return undefined;
      return {
        choices: moveChoices(group.laneSet, card.task.laneId),
        onMove: (target, laneId, answer) => requestMove(target, group, laneId, answer),
        closeLaneId: doneLaneOf(group.laneSet),
        reworkLaneId: notGoodLaneOf(group.laneSet),
        onDragStart: target => setDragging({ cardKey: target.key, groupKey: group.key }),
        onDragEnd: () => setDragging(null),
      };
    },
    [requestMove],
  );

  const doneFor = useCallback(
    (card: BoardCardOf, place: BoardCardPlace): BoardDoneControl | undefined => {
      const done = boardDone({
        laneSet: place.group.laneSet,
        category: place.category,
        dropped: card.task.dropped !== null,
      });
      return done === null
        ? undefined
        : {
            done,
            press: () => requestMove(card, place.group, done.laneId, done.kind),
            atRelease: isReleaseLane(place.group.laneSet, card.task.laneId),
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

  // ----- what the views are given -------------------------------------------------------------------
  const env = useMemo<BoardCardEnv>(
    () => ({
      names,
      now,
      showMachine: model.multiMachine || machines.length > 1,
      touch: phone,
      hrefFor: card => daemonBoardCardPath(card.daemonId, card.task.id),
      onNavigate,
      movesFor: archive ? () => undefined : movesFor,
      doneFor,
      places,
      dragging,
      answerFor,
    }),
    [
      names,
      now,
      model.multiMachine,
      machines.length,
      onNavigate,
      archive,
      movesFor,
      doneFor,
      places,
      dragging,
      phone,
      answerFor,
    ],
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
  const siblings = useMemo(
    () =>
      openCard === null
        ? []
        : model.cards
            .filter(card => card.daemonId === openCard.daemonId)
            .map(card => ({
              task: card.task,
              laneName: places.get(card.key)?.laneName ?? card.task.laneId,
              runningOn: card.runningOn,
            })),
    [model.cards, places, openCard],
  );
  const composeMachine = detailMachine ?? machines[0];
  // CALLED ON `agenda`, NEVER COPIED OFF IT. The app passes the agenda client itself, a class whose methods
  // read its own private fields; `{ hydrate: agenda.hydrate }` detached them from it, so the drawer's first
  // hydrate threw "Receiver must be an instance of class" during render and every card — opened from the
  // Board or a chat's `&task` — fell to "reload to recover" (2026-10-30). Memoised as well: a new object each
  // render re-ran the drawer's hydrate effect on every render.
  const detailAgenda = useMemo((): BoardAgenda | null => {
    const { hydrate, store: agendaStore } = agenda;
    if (hydrate === undefined || agendaStore === undefined) return null;
    return {
      hydrate: (daemon, scope) => hydrate.call(agenda, daemon, scope),
      respond: (...args) => agenda.respond(...args),
      store: agendaStore,
    };
  }, [agenda]);
  const closeDetail = useCallback(() => {
    if (openCard !== null) onNavigate(daemonBoardPath(openCard.daemonId));
  }, [openCard, onNavigate]);
  const editLanes = useCallback(
    (group: BoardGroupOf): void => onNavigate(daemonProjectLanesPath(group.daemonId, group.projectId)),
    [onNavigate],
  );
  const onlyGroup = model.groups.length === 1 ? model.groups[0] : undefined;

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

  const cardButton =
    ports === undefined || machines.length === 0 ? null : (
      <button className="kt-btn" data-variant="primary" onClick={() => setComposing(true)} type="button">
        + Card
      </button>
    );
  const scopeToggle =
    scopeFerret === null ? null : (
      <ScopeToggle
        ferret={names(scopeFerret)}
        onChange={all => setFilters({ ...filters, ferret: all ? null : scopeFerret })}
        scoped={scoped}
      />
    );
  const lanesLink =
    onlyGroup === undefined ? null : (
      <button className="fy-board__lanes" data-board-lanes="header" onClick={() => editLanes(onlyGroup)} type="button">
        Lanes ✎
      </button>
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
        {phone ? null : (
          <div className="fy-board__tools">
            {cardButton}
            {scopeToggle}
            {lanesLink}
            <PageThemeSwitch />
          </div>
        )}
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
          {cardButton}
          {scopeToggle}
          <BoardCountsBar
            activity={filters.activity}
            counts={model.counts}
            onActivity={pressCount}
            onOpenArchive={() => setView('archive')}
          />
          {lanesLink}
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
      {notice === null ? null : (
        <BoardNotice compact={phone} onDismiss={() => setNotice(null)}>
          {notice}
        </BoardNotice>
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
      {composer}
      {openCard === null || detailMachine === undefined || ports === undefined || detailAgenda === null ? null : (
        <BoardDetail
          actions={actions}
          agenda={detailAgenda}
          machine={detailMachine}
          names={names}
          now={now}
          onClose={closeDetail}
          onNavigate={onNavigate}
          phone={phone}
          ports={ports}
          projectName={id => projectNames.get(id) ?? id.slice(0, 8)}
          siblings={siblings}
          store={store}
          taskId={openCard.taskId}
        />
      )}
      {!composing || ports === undefined || composeMachine === undefined ? null : (
        <div className="fy-board__scrim">
          <BoardNewCard
            actions={actions}
            assignees={choices.ferrets.map(ferret => ({ sessionId: ferret.id, name: ferret.name }))}
            connection={composeMachine.connection}
            machineName={composeMachine.name}
            onCancel={() => setComposing(false)}
            onCreated={task => {
              setComposing(false);
              onNavigate(daemonBoardCardPath(composeMachine.connection.daemonId, task.id));
            }}
            ports={ports}
            projects={choices.projects}
          />
        </div>
      )}
    </section>
  );
}
