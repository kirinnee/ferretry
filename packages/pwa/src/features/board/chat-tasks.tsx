/**
 * THE TASKS TAB, WIRED: `BoardSideTab` plus everything that needs the network and the screen.
 *
 * The tab itself only draws. This host owns what the Board page owns for the same cards, scaled down to one
 * ferret's: the view the reader picked (kept on this device), the card detail drawer that opens OVER the chat
 * (portalled to the body, so the Info panel's own scrolling and stacking cannot clip it), and the move flow
 * behind Done ✓, Not good and the ⋯ menu — a move back asks for its reason first, exactly as on the Board.
 * Drawn small in the Info panel, or at page density when `expanded` (the chat page lays that over the chat);
 * either way it is this one host, so a move, the drawer and the reason box behave the same in both.
 * Nothing here navigates: a card link inside the drawer reopens the drawer on that card.
 */

import { type ReactElement, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type BoardMachine, useBoardActions, useBoardProjects } from '../../hooks/use-board.ts';
import type { BoardChat, ChatKanbanLane } from '../../lib/board-chat.ts';
import { chatSiblings } from '../../lib/board-chat.ts';
import { boardDone, isReleaseLane } from '../../lib/board-done.ts';
import { moveChoices, planMove } from '../../lib/board-move.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import { boardSideView } from '../../lib/board-side-view.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import { type BoardCardOf, type BoardCardPlace, laneOfCategory } from '../../lib/board-view.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath, daemonBoardPath } from '../../lib/pages/routes.ts';
import type { BoardCardMoves } from './board-card.tsx';
import { BoardReasonBox } from './board-reason-box.tsx';
import { BoardSideTab } from './board-side-tab.tsx';
import type { BoardDoneControl } from './board-views.tsx';
import { type BoardAgenda, BoardDetail, type BoardDetailPorts } from './detail/board-detail.tsx';

export interface ChatTasksProps {
  readonly store: DaemonBoardStore;
  /** With `ports`, a card opens in the drawer; without them (a host that cannot speak to ferrets) it opens on the Board. */
  readonly agenda?: Pick<BoardAgenda, 'respond'> & Partial<Pick<BoardAgenda, 'hydrate' | 'store'>>;
  readonly ports?: BoardDetailPorts;
  readonly machine: BoardMachine;
  readonly chat: BoardChat;
  readonly scope: DaemonSessionScope;
  readonly callsigns: ReadonlyMap<string, string>;
  /** A phone shows the open card as a page of its own, over the chat. */
  readonly phone: boolean;
  readonly now: number;
  /** Where a link inside the drawer that is not a card of this ferret goes. */
  readonly onNavigate?: (to: string) => void;
  /** "Show agent tasks" on or off (`chat.agents` is its current value). */
  readonly onAgents: (agents: boolean) => void;
  /** The tab fills the chat, at page density; the button then collapses it. */
  readonly expanded?: boolean;
  /** Expands the tab to the chat, or collapses it back; absent: the tab has no such button. */
  readonly onExpand?: () => void;
}

interface PendingMove {
  readonly card: BoardCardOf;
  readonly place: BoardCardPlace;
  readonly to: string;
  readonly toName: string;
}

const refuseAgenda = (): Promise<never> => Promise.reject(new Error('this host has no agenda'));
const NO_AGENDA: Pick<BoardAgenda, 'respond'> = { respond: refuseAgenda };

const subscribeView = (listener: () => void): (() => void) => boardSideView.subscribe(listener);
const readView = () => boardSideView.snapshot();

/** The card id a board address names, when it is one of this machine's cards. */
const cardIdOf = (to: string, daemonId: DaemonId): string | null => {
  const base = `${daemonBoardPath(daemonId)}/`;
  const path = to.split(/[?#]/)[0] ?? '';
  if (!path.startsWith(base)) return null;
  const id = decodeURIComponent(path.slice(base.length));
  return id === '' || id.includes('/') ? null : id;
};

export function ChatTasks({
  store,
  agenda,
  ports,
  machine,
  chat,
  scope,
  callsigns,
  phone,
  now,
  onNavigate,
  onAgents,
  expanded = false,
  onExpand,
}: ChatTasksProps): ReactElement {
  const view = useSyncExternalStore(subscribeView, readView, readView);
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
  const connections = useMemo(() => [machine.connection], [machine.connection]);
  const actions = useBoardActions(store, agenda ?? NO_AGENDA, connections);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BoardCardOf | null>(null);

  const send = useCallback(
    async (card: BoardCardOf, place: BoardCardPlace, to: string, reason?: string): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      const result = await actions.moveTask(
        { daemonId: card.daemonId, id: card.task.id, laneId: card.task.laneId, laneSet: place.group.laneSet },
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
    (card: BoardCardOf, place: BoardCardPlace, laneId: string): void => {
      const plan = planMove(place.group.laneSet, card.task.laneId, laneId);
      setNotice(null);
      if (plan.kind === 'refused') {
        setNotice(plan.message);
        return;
      }
      if (plan.kind === 'ask-reason') {
        const toName = place.group.laneSet?.lanes.find(lane => lane.id === plan.to)?.name ?? plan.to;
        setProblem(null);
        setPending({ card, place, to: plan.to, toName });
        return;
      }
      if (plan.kind === 'send') {
        void send(card, place, plan.to).then(ok => {
          if (!ok) setNotice('The move did not go through.');
        });
      }
    },
    [send],
  );

  const movesFor = useCallback(
    (card: BoardCardOf, place: BoardCardPlace): BoardCardMoves | undefined => {
      const { group } = place;
      if (group.laneSet === null) return undefined;
      // A closed card has no lane to move to: its menu holds Reopen alone.
      const closed = place.category === 'closed';
      return {
        choices: closed ? [] : moveChoices(group.laneSet, card.task.laneId),
        onMove: (target, laneId) => requestMove(target, place, laneId),
        closeLaneId: closed ? null : laneOfCategory(group, 'closed'),
        reworkLaneId: closed ? null : laneOfCategory(group, 'active', 'last'),
        onDragStart: setDragging,
        onDragEnd: () => setDragging(null),
      };
    },
    [requestMove],
  );

  const dropOn = useCallback(
    (card: BoardCardOf, lane: ChatKanbanLane): void => {
      setDragging(null);
      const place = chat.cards.places.get(card.key);
      if (place !== undefined && lane.laneId !== null) requestMove(card, place, lane.laneId);
    },
    [chat.cards.places, requestMove],
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
            press: () => requestMove(card, place, done.laneId),
            atRelease: isReleaseLane(place.group.laneSet, card.task.laneId),
          };
    },
    [requestMove],
  );

  const submitReason = async (reason: string): Promise<void> => {
    if (pending === null) return;
    const ok = await send(pending.card, pending.place, pending.to, reason);
    if (ok) setPending(null);
  };

  // CALLED ON `agenda`, NEVER COPIED OFF IT: its methods read the client's own private fields.
  const detailAgenda = useMemo((): BoardAgenda | null => {
    if (agenda === undefined) return null;
    const { hydrate, store: agendaStore } = agenda;
    if (hydrate === undefined || agendaStore === undefined) return null;
    return {
      hydrate: (daemon, daemonScope) => hydrate.call(agenda, daemon, daemonScope),
      respond: (...args) => agenda.respond(...args),
      store: agendaStore,
    };
  }, [agenda]);

  const siblings = useMemo(() => chatSiblings(chat.cards), [chat.cards]);
  const daemonId = machine.connection.daemonId;
  const projects = useBoardProjects(store, connections);
  const projectNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const state of projects.values())
      for (const project of state.projects ?? []) byId.set(project.id, project.name);
    return byId;
  }, [projects]);
  const drawer = detailAgenda !== null && ports !== undefined;
  const openCard = useCallback(
    (card: BoardCardOf): void => {
      if (drawer) setOpenId(card.task.id);
      else onNavigate?.(daemonBoardCardPath(card.daemonId, card.task.id));
    },
    [drawer, onNavigate],
  );
  const navigateFromDrawer = useCallback(
    (to: string): void => {
      const id = cardIdOf(to, daemonId);
      if (id !== null) {
        setOpenId(id);
        return;
      }
      setOpenId(null);
      onNavigate?.(to);
    },
    [daemonId, onNavigate],
  );

  return (
    <>
      {notice === null ? null : (
        <p className="fy-board-side__notice" data-board-side-notice="" role="status">
          {notice}
        </p>
      )}
      <BoardSideTab
        callsigns={callsigns}
        chat={chat}
        density={expanded ? 'page' : 'side'}
        doneFor={doneFor}
        dragging={dragging}
        movesFor={movesFor}
        now={now}
        onAgents={onAgents}
        onDropCard={dropOn}
        onExpand={onExpand}
        onOpenCard={openCard}
        onView={next => boardSideView.set(next)}
        scope={scope}
        view={view}
      />
      {pending === null
        ? null
        : createPortal(
            <div className="fy-board__scrim" data-phone={phone ? '' : undefined}>
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
            </div>,
            document.body,
          )}
      {openId === null || detailAgenda === null || ports === undefined
        ? null
        : createPortal(
            <BoardDetail
              actions={actions}
              agenda={detailAgenda}
              machine={machine}
              names={names}
              now={now}
              onClose={() => setOpenId(null)}
              onNavigate={navigateFromDrawer}
              phone={phone}
              ports={ports}
              projectName={id => projectNames.get(id) ?? id.slice(0, 8)}
              siblings={siblings}
              store={store}
              taskId={openId}
            />,
            document.body,
          )}
    </>
  );
}
