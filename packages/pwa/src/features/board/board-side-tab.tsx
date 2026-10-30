/**
 * THE PER-CHAT "TASKS" TAB: the board filtered to this ferret, drawn small, as a Kanban or as a List.
 *
 * Both views draw the same cards (`chatDrawn`) with the same `BoardCard` at `density="side"`, so switching
 * changes how they are arranged and nothing else:
 *  - **Kanban** (the default): one narrow column per lane that holds one of this ferret's cards, scrolling
 *    sideways, snapping a column at a time.
 *  - **List**: the focus card, the cards it owns (one collapsible lane each), then the cards its sub-ferrets
 *    hold as a mini tree.
 *
 * A card opens in the host's drawer (`onOpenCard`), never by leaving the chat. "Add to chat" is a card action:
 * it puts the card's `&F18` into THIS session's draft. The owner's Done and Not good ride on the card where
 * the host supplies them (`movesFor`, `doneFor`); a host that does not leaves the cards read-only.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { Columns3, List } from 'lucide-react';
import { type ReactElement, useCallback, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { BoardChat } from '../../lib/board-chat.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import type { BoardSideView } from '../../lib/board-side-view.ts';
import type { BoardCardOf, BoardCardPlace } from '../../lib/board-view.ts';
import { addReferenceMessage, addReferenceToComposer } from '../../lib/composer-references.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import { BoardCard, type BoardCardMoves } from './board-card.tsx';
import { BoardLane } from './board-lane.tsx';
import type { BoardDoneControl } from './board-views.tsx';

export interface BoardSideTabProps {
  readonly chat: BoardChat;
  /** The session the tab belongs to: "Add to chat" lands in its composer and nowhere else. */
  readonly scope: DaemonSessionScope;
  /** Ferret callsigns by session id. */
  readonly callsigns: ReadonlyMap<string, string>;
  readonly now: number;
  readonly view: BoardSideView;
  readonly onView: (view: BoardSideView) => void;
  /** Opens a card's detail where the reader is, over the chat. */
  readonly onOpenCard: (card: BoardCardOf) => void;
  /** The owner's moves (Not good, the ⋯ menu); absent: the cards cannot be moved from here. */
  readonly movesFor?: (card: BoardCardOf, place: BoardCardPlace) => BoardCardMoves | undefined;
  /** The owner's Done ✓; absent: the cards cannot be closed from here. */
  readonly doneFor?: (card: BoardCardOf, place: BoardCardPlace) => BoardDoneControl | undefined;
}

const VIEWS: readonly { readonly id: BoardSideView; readonly label: string; readonly Icon: typeof List }[] = [
  { id: 'kanban', label: 'Kanban', Icon: Columns3 },
  { id: 'list', label: 'List', Icon: List },
];

function ViewToggle({
  view,
  onView,
}: {
  readonly view: BoardSideView;
  readonly onView: (view: BoardSideView) => void;
}): ReactElement {
  return (
    <fieldset aria-label="How the cards are arranged" className="fy-board-side__views" data-board-side-views={view}>
      {VIEWS.map(({ id, label, Icon }) => (
        <button
          aria-pressed={view === id}
          className="fy-board-side__view"
          data-view={id}
          key={id}
          onClick={() => onView(id)}
          type="button"
        >
          <Icon aria-hidden="true" size={12} />
          {label}
        </button>
      ))}
    </fieldset>
  );
}

export function BoardSideTab({
  chat,
  scope,
  callsigns,
  now,
  view,
  onView,
  onOpenCard,
  movesFor,
  doneFor,
}: BoardSideTabProps): ReactElement {
  const { cards, status } = chat;
  const names = ferretNamer(callsigns);
  const [message, setMessage] = useState('');
  const addToChat = useCallback(
    (card: BoardCardOf): void => {
      const outcome = addReferenceToComposer({ kind: 'task', id: card.task.id }, scope);
      setMessage(addReferenceMessage(outcome, formatTaskRef(card.task)));
    },
    [scope],
  );
  const draw = (card: BoardCardOf, extra: { readonly depth?: number; readonly lane?: string } = {}): ReactElement => {
    const place = cards.places.get(card.key);
    const moves = place === undefined ? undefined : movesFor?.(card, place);
    const done = place === undefined ? undefined : doneFor?.(card, place);
    return (
      <BoardCard
        card={card}
        category={place?.category ?? null}
        density="side"
        href={daemonBoardCardPath(card.daemonId, card.task.id)}
        key={card.key}
        names={names}
        now={now}
        onAddToChat={addToChat}
        onNavigate={() => onOpenCard(card)}
        showMachine={false}
        {...(moves === undefined ? {} : { moves })}
        {...(done === undefined ? {} : { done })}
        {...extra}
      />
    );
  };

  return (
    <section aria-label="This ferret's cards" className="fy-board-side" data-board-side="" data-view={view}>
      <p className={message === '' ? 'sr-only' : 'fy-board-side__status'} data-board-side-status="" role="status">
        {message}
      </p>
      {cards.total === 0 ? (
        status === 'error' ? (
          <p className="fy-board-empty" role="alert">
            The board could not be read.{' '}
            <button className="fy-board__retry" onClick={chat.refresh} type="button">
              Try again
            </button>
          </p>
        ) : status === 'ready' ? (
          <p className="fy-board-empty">This ferret has no cards.</p>
        ) : (
          <p className="fy-board__reading" role="status">
            <Spinner size={14} />
            Reading the board…
          </p>
        )
      ) : (
        <>
          <ViewToggle onView={onView} view={view} />
          {view === 'kanban' ? (
            <div className="fy-board-side__kanban" data-board-side-kanban="">
              {cards.lanes.map(lane => (
                <BoardLane
                  category={lane.category}
                  count={lane.cards.length}
                  density="side"
                  key={lane.key}
                  name={lane.name}
                >
                  {lane.cards.map(card => draw(card))}
                </BoardLane>
              ))}
            </div>
          ) : (
            <>
              {cards.focus === null ? null : (
                <BoardLane
                  category={cards.places.get(cards.focus.key)?.category ?? null}
                  count={1}
                  density="side"
                  name="Focus"
                >
                  {draw(cards.focus)}
                </BoardLane>
              )}
              {cards.owned.map(group => (
                <BoardLane
                  category={cards.places.get(group.cards[0]?.key ?? '')?.category ?? null}
                  count={group.cards.length}
                  density="side"
                  key={group.key}
                  name={`Owned · ${group.laneName}`}
                >
                  {group.cards.map(card => draw(card))}
                </BoardLane>
              ))}
              {cards.children.length === 0 ? null : (
                <BoardLane category={null} count={cards.children.length} density="side" name="Sub-ferrets">
                  {cards.children.map(row =>
                    draw(row.card, {
                      depth: row.depth,
                      lane: cards.places.get(row.card.key)?.laneName ?? row.card.task.laneId,
                    }),
                  )}
                </BoardLane>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
