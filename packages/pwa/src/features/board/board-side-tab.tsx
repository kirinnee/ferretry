/**
 * THE PER-CHAT "TASKS" TAB: the board filtered to this ferret, drawn small.
 *
 * Top to bottom: its focus card, the cards it owns (one collapsible lane each), then the cards its
 * sub-ferrets hold as a mini tree. It is the same `BoardCard` and `BoardLane` as the Board page at
 * `density="side"`, and what it draws is `useChatCard`'s, so it follows the live board. "Add to chat"
 * is a card action: it puts the card's `&F18` into THIS session's draft.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { type ReactElement, useCallback, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { BoardChat } from '../../lib/board-chat.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';
import { addReferenceMessage, addReferenceToComposer } from '../../lib/composer-references.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import { BoardCard } from './board-card.tsx';
import { BoardLane } from './board-lane.tsx';

export interface BoardSideTabProps {
  readonly chat: BoardChat;
  /** The session the tab belongs to: "Add to chat" lands in its composer and nowhere else. */
  readonly scope: DaemonSessionScope;
  /** Ferret callsigns by session id. */
  readonly callsigns: ReadonlyMap<string, string>;
  readonly onNavigate?: (to: string) => void;
  readonly now: number;
}

export function BoardSideTab({ chat, scope, callsigns, onNavigate, now }: BoardSideTabProps): ReactElement {
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
  const draw = (card: BoardCardOf, extra: { readonly depth?: number; readonly lane?: string } = {}): ReactElement => (
    <BoardCard
      card={card}
      category={cards.places.get(card.key)?.category ?? null}
      density="side"
      href={daemonBoardCardPath(card.daemonId, card.task.id)}
      key={card.key}
      names={names}
      now={now}
      onAddToChat={addToChat}
      onNavigate={onNavigate}
      showMachine={false}
      {...extra}
    />
  );

  return (
    <section aria-label="This ferret's cards" className="fy-board-side" data-board-side="">
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
    </section>
  );
}
