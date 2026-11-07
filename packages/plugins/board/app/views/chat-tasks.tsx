/**
 * THE TASKS TAB, WIRED: `BoardSideTab` plus everything that needs the network and the screen.
 *
 * The tab itself only draws. This host owns what the Board page owns for the same cards, scaled down to one
 * ferret's: the view the reader picked (kept on this device; Cards until one is) and the card detail drawer that
 * opens OVER the chat (portalled to the body, so the Info panel's own scrolling and stacking cannot clip it).
 * It is READ-ONLY: no lane menu, no drag, no Done / Not good / Reopen — the board moves its own cards and the owner
 * answers in the agenda.
 * Drawn small in the Info panel, or at page density when `expanded` (the chat page lays that over the chat);
 * either way it is this one host, so the drawer behaves the same in both.
 * Nothing here navigates: a card link inside the drawer reopens the drawer on that card.
 */

import { type ReactElement, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type BoardMachine, useBoardProjects } from '../hooks/use-board.ts';
import type { BoardChat } from '../lib/board-chat.ts';
import { chatSiblings } from '../lib/board-chat.ts';
import { ferretNamer } from '../lib/board-present.ts';
import { boardSideView } from '../lib/board-side-view.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { BoardCardOf } from '../lib/board-view.ts';
import type { DaemonId, FerretScope } from '../lib/machine.ts';
import { boardPath } from '../lib/paths.ts';
import { BoardSideTab } from './board-side-tab.tsx';
import { BoardDetail } from './detail/board-detail.tsx';

export interface ChatTasksProps {
  readonly store: DaemonBoardStore;
  readonly machine: BoardMachine;
  readonly chat: BoardChat;
  readonly scope: FerretScope;
  readonly callsigns: ReadonlyMap<string, string>;
  /** A phone shows the open card as a page of its own, over the chat. */
  readonly phone: boolean;
  readonly now: number;
  /** Where a link inside the drawer that is not a card of this ferret goes. */
  readonly onNavigate?: (to: string) => void;
  /** "Show private" on or off (`chat.agents` is its current value). */
  readonly onAgents: (agents: boolean) => void;
  /** The tab fills the chat, at page density; the button then collapses it. */
  readonly expanded?: boolean;
  /** Expands the tab to the chat, or collapses it back; absent: the tab has no such button. */
  readonly onExpand?: () => void;
}

const subscribeView = (listener: () => void): (() => void) => boardSideView.subscribe(listener);
const readView = () => boardSideView.snapshot();

/** The card id a board address names, when it is one of this machine's cards. */
const cardIdOf = (to: string, daemonId: DaemonId): string | null => {
  const base = `${boardPath(daemonId)}/`;
  const path = to.split(/[?#]/)[0] ?? '';
  if (!path.startsWith(base)) return null;
  const id = decodeURIComponent(path.slice(base.length));
  return id === '' || id.includes('/') ? null : id;
};

export function ChatTasks({
  store,
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
  const [openId, setOpenId] = useState<string | null>(null);

  const siblings = useMemo(() => chatSiblings(chat.cards), [chat.cards]);
  const daemonId = machine.connection.daemonId;
  const projects = useBoardProjects(store, connections);
  const projectNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const state of projects.values())
      for (const project of state.projects ?? []) byId.set(project.id, project.name);
    return byId;
  }, [projects]);
  const openCard = useCallback(
    (card: BoardCardOf): void => {
      setOpenId(card.task.id);
    },
    [],
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
      <BoardSideTab
        callsigns={callsigns}
        chat={chat}
        density={expanded ? 'page' : 'side'}
        now={now}
        onAgents={onAgents}
        onExpand={onExpand}
        onOpenCard={openCard}
        onView={next => boardSideView.set(next)}
        scope={scope}
        view={view}
      />
      {openId === null
        ? null
        : createPortal(
            <BoardDetail
              machine={machine}
              names={names}
              now={now}
              onClose={() => setOpenId(null)}
              onNavigate={navigateFromDrawer}
              phone={phone}
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
