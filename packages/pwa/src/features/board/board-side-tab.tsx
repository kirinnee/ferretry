/**
 * THE PER-CHAT "TASKS" TAB: the board filtered to this ferret, drawn small, as Cards, a Kanban or a List.
 *
 * Every view draws the same cards (`chatDrawn`), so switching changes how they are arranged and nothing else:
 *  - **Cards** (the default): one card at a time with `‹ n of N ›`, what needs the owner first; a card waiting for a
 *    try is the shared Done / Not good row (swipe on a phone), the rest are the `BoardCard` the other views draw.
 *  - **Kanban**: one narrow column per lane that holds one of this ferret's cards, scrolling
 *    sideways, snapping a column at a time.
 *  - **List**: the focus card, the cards it owns (one collapsible lane each), then the cards its sub-ferrets
 *    hold as a mini tree.
 *
 * The tab has two sizes, one renderer: `side` in the Info panel, and `page` when the host lets it fill the chat
 * (`onExpand`), where the same cards and lanes are drawn at the Board page's density. "Show agent tasks" is the
 * Board page's own toggle and filter: off, only the owner's cards are drawn; on, an agent card sits under the
 * human card it serves.
 *
 * A card opens in the host's drawer (`onOpenCard`), never by leaving the chat. "Add to chat" is a card action:
 * it puts the card's `&F18` into THIS session's draft. The owner's Done and Not good ride on the card where
 * the host supplies them (`movesFor`, `doneFor`); a host that does not leaves the cards read-only.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { Columns3, Layers, List, Maximize2, Minimize2 } from 'lucide-react';
import { type ReactElement, useCallback, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { BoardChat, ChatKanbanLane } from '../../lib/board-chat.ts';
import type { BoardAnswerState } from '../../lib/board-done.ts';
import { NO_BOARD_FILTERS } from '../../lib/board-model.ts';
import { ferretNamer } from '../../lib/board-present.ts';
import type { BoardSideView } from '../../lib/board-side-view.ts';
import type { BoardCardOf, BoardCardPlace } from '../../lib/board-view.ts';
import { addReferenceMessage, addReferenceToComposer } from '../../lib/composer-references.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import type { ToTestAnswers } from '../agenda/to-test-rows.tsx';
import { BoardCard, type BoardCardMoves, type BoardDensity } from './board-card.tsx';
import { BoardCardsView } from './board-cards-view.tsx';
import { AgentsToggle } from './board-filters.tsx';
import { BoardLane } from './board-lane.tsx';
import type { BoardDoneControl } from './board-views.tsx';

export interface BoardSideTabProps {
  readonly chat: BoardChat;
  /** The session the tab belongs to: "Add to chat" lands in its composer and nowhere else. */
  readonly scope: DaemonSessionScope;
  /** Ferret callsigns by session id. */
  readonly callsigns: ReadonlyMap<string, string>;
  /** The task each ferret was given, by session id (the Cards view's card to test names its ferret by it). */
  readonly taskNames?: ReadonlyMap<string, string> | undefined;
  readonly now: number;
  readonly view: BoardSideView;
  readonly onView: (view: BoardSideView) => void;
  /** Opens a card's detail where the reader is, over the chat. */
  readonly onOpenCard: (card: BoardCardOf) => void;
  /** The owner's moves (Not good, the ⋯ menu); absent: the cards cannot be moved from here. */
  readonly movesFor?: (card: BoardCardOf, place: BoardCardPlace) => BoardCardMoves | undefined;
  /** The owner's Done ✓; absent: the cards cannot be closed from here. */
  readonly doneFor?: (card: BoardCardOf, place: BoardCardPlace) => BoardDoneControl | undefined;
  /** `side` in the Info panel; `page` when the tab fills the chat. */
  readonly density?: BoardDensity;
  /** "Show agent tasks" on or off. */
  readonly onAgents: (agents: boolean) => void;
  /** Expands the tab to the whole chat (at `side`) or collapses it back to the panel (at `page`); absent: no button. */
  readonly onExpand?: () => void;
  /** The card in the air, while one is being dragged at page density. */
  readonly dragging?: BoardCardOf | null;
  /** A card was dropped on a lane (only lanes of the dragged card's own board take drops). */
  readonly onDropCard?: (card: BoardCardOf, lane: ChatKanbanLane) => void;
  /** The owner's answer in flight on a card, and its last refusal; every card is at rest when absent. */
  readonly answerFor?: (card: BoardCardOf) => BoardAnswerState;
  /** The shared Done / Not good row for a card waiting for a try (the Cards view); absent: such a card is drawn as any other. */
  readonly toTestAnswers?: ToTestAnswers;
}

const VIEWS: readonly { readonly id: BoardSideView; readonly label: string; readonly Icon: typeof List }[] = [
  { id: 'cards', label: 'Cards', Icon: Layers },
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

function Toolbar({
  chat,
  density,
  view,
  onView,
  onAgents,
  onExpand,
}: Pick<BoardSideTabProps, 'chat' | 'view' | 'onView' | 'onAgents' | 'onExpand'> & {
  readonly density: BoardDensity;
}): ReactElement {
  const expanded = density === 'page';
  const Icon = expanded ? Minimize2 : Maximize2;
  return (
    <div className="fy-board-side__bar" data-board-side-bar="">
      <ViewToggle onView={onView} view={view} />
      {chat.splitsAgents ? (
        <AgentsToggle
          filters={{ ...NO_BOARD_FILTERS, agents: chat.agents }}
          onChange={next => onAgents(next.agents)}
          short
        />
      ) : null}
      {onExpand === undefined ? null : (
        <button
          aria-label={expanded ? 'Collapse the tasks back to the panel' : 'Expand the tasks to the whole chat'}
          className="fy-board-side__expand"
          data-board-side-expand={expanded ? 'collapse' : 'expand'}
          onClick={onExpand}
          title={expanded ? 'Collapse' : 'Expand'}
          type="button"
        >
          <Icon aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}

export function BoardSideTab({
  chat,
  scope,
  callsigns,
  taskNames,
  now,
  view,
  onView,
  onOpenCard,
  movesFor,
  doneFor,
  density = 'side',
  onAgents,
  onExpand,
  dragging = null,
  onDropCard,
  answerFor,
  toTestAnswers,
}: BoardSideTabProps): ReactElement {
  const { cards, status } = chat;
  const draggedGroup = dragging === null ? null : (cards.places.get(dragging.key)?.group.key ?? null);
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
    const answer = answerFor?.(card);
    return (
      <BoardCard
        card={card}
        category={place?.category ?? null}
        density={density}
        href={daemonBoardCardPath(card.daemonId, card.task.id)}
        {...(dragging?.key === card.key ? { dragging: true } : {})}
        depth={extra.depth ?? (cards.under.has(card.key) ? 1 : undefined)}
        key={card.key}
        names={names}
        now={now}
        onAddToChat={addToChat}
        onNavigate={() => onOpenCard(card)}
        showMachine={false}
        {...(moves === undefined ? {} : { moves })}
        {...(done === undefined ? {} : { done })}
        {...(answer === undefined ? {} : { answer })}
        {...(extra.lane === undefined ? {} : { lane: extra.lane })}
      />
    );
  };

  return (
    <section
      aria-label="This ferret's cards"
      className="fy-board-side"
      data-board-side=""
      data-density={density}
      data-view={view}
    >
      <p className={message === '' ? 'sr-only' : 'fy-board-side__status'} data-board-side-status="" role="status">
        {message}
      </p>
      {density === 'page' ? (
        <h2 className="fy-board-side__title">
          This ferret's tasks <span className="fy-board-side__total">{cards.total}</span>
        </h2>
      ) : null}
      {cards.total > 0 || chat.splitsAgents || density === 'page' ? (
        <Toolbar chat={chat} density={density} onAgents={onAgents} onExpand={onExpand} onView={onView} view={view} />
      ) : null}
      {cards.total === 0 ? (
        status === 'error' ? (
          <p className="fy-board-empty" role="alert">
            The board could not be read.{' '}
            <button className="fy-board__retry" onClick={chat.refresh} type="button">
              Try again
            </button>
          </p>
        ) : status === 'ready' ? (
          <p className="fy-board-empty" data-board-side-empty="">
            {cards.hiddenAgents === 0
              ? 'This ferret has no cards.'
              : `No tasks of your own yet. ${cards.hiddenAgents} agent ${cards.hiddenAgents === 1 ? 'task is' : 'tasks are'} hidden.`}
          </p>
        ) : (
          <p className="fy-board__reading" role="status">
            <Spinner size={14} />
            Reading the board…
          </p>
        )
      ) : (
        <>
          {view === 'cards' ? (
            <BoardCardsView
              cards={cards}
              draw={draw}
              now={now}
              onOpenCard={onOpenCard}
              taskNames={taskNames}
              toTestAnswers={toTestAnswers}
            />
          ) : view === 'kanban' ? (
            <div className={density === 'page' ? 'fy-board-kanban' : 'fy-board-side__kanban'} data-board-side-kanban="">
              {cards.lanes.map(lane => (
                <BoardLane
                  accepts={
                    dragging !== null &&
                    lane.laneId !== null &&
                    lane.groupKey === draggedGroup &&
                    lane.laneId !== dragging.task.laneId
                  }
                  category={lane.category}
                  count={lane.cards.length}
                  density={density}
                  key={lane.key}
                  name={lane.name}
                  {...(dragging === null || onDropCard === undefined
                    ? {}
                    : { onDropCard: () => onDropCard(dragging, lane) })}
                >
                  {lane.cards.map(card => draw(card))}
                </BoardLane>
              ))}
            </div>
          ) : (
            <>
              {cards.shownFocus === null ? null : (
                <BoardLane
                  category={cards.places.get(cards.shownFocus.key)?.category ?? null}
                  count={1}
                  density={density}
                  name="Focus"
                >
                  {draw(cards.shownFocus)}
                </BoardLane>
              )}
              {cards.owned.map(group => (
                <BoardLane
                  category={cards.places.get(group.cards[0]?.key ?? '')?.category ?? null}
                  count={group.cards.length}
                  density={density}
                  key={group.key}
                  name={`Owned · ${group.laneName}`}
                >
                  {group.cards.map(card => draw(card))}
                </BoardLane>
              ))}
              {cards.children.length === 0 ? null : (
                <BoardLane category={null} count={cards.children.length} density={density} name="Sub-ferrets">
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
