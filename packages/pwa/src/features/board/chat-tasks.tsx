/**
 * THE TASKS TAB, WIRED: `BoardSideTab` plus everything that needs the network and the screen.
 *
 * The tab itself only draws. This host owns what the Board page owns for the same cards, scaled down to one
 * ferret's: the view the reader picked (kept on this device), the card detail drawer that opens OVER the chat
 * (portalled to the body, so the Info panel's own scrolling and stacking cannot clip it), and the move flow
 * behind Done ✓, Not good and the ⋯ menu, which is the Board's own (`useBoardAnswers`): a move back opens the same
 * composer, the pressed answer spins and the card's others wait, and a refusal is said on the card.
 * Nothing here navigates: a card link inside the drawer reopens the drawer on that card.
 */

import { type ReactElement, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type BoardMachine, useBoardActions, useBoardProjects } from '../../hooks/use-board.ts';
import type { BoardChat } from '../../lib/board-chat.ts';
import { chatSiblings } from '../../lib/board-chat.ts';
import { boardDone, doneLaneOf, isReleaseLane, notGoodLaneOf } from '../../lib/board-done.ts';
import { moveChoices } from '../../lib/board-move.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import { boardSideView } from '../../lib/board-side-view.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import type { BoardCardOf, BoardCardPlace } from '../../lib/board-view.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath, daemonBoardPath } from '../../lib/pages/routes.ts';
import type { BoardCardMoves } from './board-card.tsx';
import { useBoardAnswers } from './board-answers.tsx';
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
}: ChatTasksProps): ReactElement {
  const view = useSyncExternalStore(subscribeView, readView, readView);
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
  const connections = useMemo(() => [machine.connection], [machine.connection]);
  const actions = useBoardActions(store, agenda ?? NO_AGENDA, connections);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { requestMove, answerFor, composer } = useBoardAnswers({
    actions,
    ports,
    connectionOf: id => (id === machine.connection.daemonId ? machine.connection : undefined),
    phone,
    onNotice: setNotice,
    // The Info panel scrolls and stacks on its own; the composer goes over the whole page.
    portal: true,
  });

  const movesFor = useCallback(
    (card: BoardCardOf, place: BoardCardPlace): BoardCardMoves | undefined => {
      const { group } = place;
      if (group.laneSet === null) return undefined;
      // A closed card has no lane to move to: its menu holds Reopen alone.
      const closed = place.category === 'closed';
      return {
        choices: closed ? [] : moveChoices(group.laneSet, card.task.laneId),
        onMove: (target, laneId, answer) => requestMove(target, group, laneId, answer),
        closeLaneId: closed ? null : doneLaneOf(group.laneSet),
        reworkLaneId: closed ? null : notGoodLaneOf(group.laneSet),
        onDragStart: () => undefined,
        onDragEnd: () => undefined,
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
        answerFor={answerFor}
        doneFor={doneFor}
        movesFor={movesFor}
        now={now}
        onOpenCard={openCard}
        onView={next => boardSideView.set(next)}
        scope={scope}
        view={view}
      />
      {composer}
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
