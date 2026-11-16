/**
 * THE PER-CHAT "TASKS" TAB: the board filtered to this ferret, drawn small, as a Kanban or a List.
 *
 * Every view draws the same cards (`chatDrawn`), so switching changes how they are arranged and nothing else:
 *  - **List** (the default): the focus card, the cards it owns (one collapsible lane each), then the cards its
 *    sub-ferrets hold as a mini tree.
 *  - **Kanban**: one narrow column per lane that holds one of this ferret's cards, scrolling
 *    sideways, snapping a column at a time.
 *
 * The tab has two sizes, one renderer: `side` in the Info panel, and `page` when the host lets it fill the chat
 * (`onExpand`), where the same cards and lanes are drawn at the Board page's density. "Show private" is the
 * Board page's own toggle and filter: off, only the owner's cards are drawn; on, an agent card sits under the
 * human card it serves.
 *
 * A card opens in the host's drawer (`onOpenCard`), never by leaving the chat. "Add to chat" is a card action:
 * it puts the card's `&F18` into THIS session's draft. The tab is READ-ONLY: a card has no owner buttons (no Done,
 * no Not good, no lane menu), cannot be dragged and no lane takes a drop. The owner answers in the agenda.
 */

import { formatCardRef } from '../../contract/index.ts';
import { Columns3, List, Maximize2, Minimize2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Spinner } from '@ferretry/app/ui';
import type { BoardChat } from '../lib/board-chat.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { ferretNamer } from '../lib/board-present.ts';
import type { BoardSideView } from '../lib/board-side-view.ts';
import type { BoardCardOf } from '../lib/board-view.ts';
import { useAddToChat } from '../lib/add-to-chat.ts';
import type { FerretScope } from '../lib/machine.ts';
import { boardCardPath } from '../lib/paths.ts';
import { BoardCard, type BoardDensity } from './board-card.tsx';
import { InternalToggle } from './board-filters.tsx';
import { BoardLane } from './board-lane.tsx';

export interface BoardSideTabProps {
  readonly chat: BoardChat;
  /** The session the tab belongs to: "Add to chat" lands in its composer and nowhere else. */
  readonly scope: FerretScope;
  /** Ferret callsigns by session id. */
  readonly callsigns: ReadonlyMap<string, string>;
  readonly now: number;
  readonly view: BoardSideView;
  readonly onView: (view: BoardSideView) => void;
  /** Opens a card's detail where the reader is, over the chat. */
  readonly onOpenCard: (card: BoardCardOf) => void;
  /** `side` in the Info panel; `page` when the tab fills the chat. */
  readonly density?: BoardDensity;
  /** "Show private" on or off. */
  readonly onAgents: (agents: boolean) => void;
  /** Expands the tab to the whole chat (at `side`) or collapses it back to the panel (at `page`); absent: no button. */
  readonly onExpand?: () => void;
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
        <InternalToggle
          filters={{ ...NO_BOARD_FILTERS, agents: chat.agents }}
          onChange={next => onAgents(next.agents)}
        />
      ) : null}
      {onExpand === undefined ? null : (
        <button
          aria-label={expanded ? 'Collapse the cards back to the panel' : 'Expand the cards to the whole chat'}
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
  now,
  view,
  onView,
  onOpenCard,
  density = 'side',
  onAgents,
  onExpand,
}: BoardSideTabProps): ReactElement {
  const { cards, status } = chat;
  const names = ferretNamer(callsigns);
  const [message, setMessage] = useState('');
  const addReference = useAddToChat();
  const addToChat = (card: BoardCardOf): void => {
    setMessage(addReference(scope.ferret, formatCardRef(card.task)));
  };
  const draw = (card: BoardCardOf, extra: { readonly depth?: number; readonly lane?: string } = {}): ReactElement => {
    const place = cards.places.get(card.key);
    return (
      <BoardCard
        card={card}
        category={place?.category ?? null}
        density={density}
        href={boardCardPath(card.daemonId, card.task.id)}
        depth={extra.depth ?? (cards.under.has(card.key) ? 1 : undefined)}
        key={card.key}
        names={names}
        now={now}
        onAddToChat={addToChat}
        onNavigate={() => onOpenCard(card)}
        showMachine={false}
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
          This ferret's cards <span className="fy-board-side__total">{cards.total}</span>
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
              : `No cards of your own yet. ${cards.hiddenAgents} agent ${cards.hiddenAgents === 1 ? 'card is' : 'cards are'} hidden.`}
          </p>
        ) : (
          <p className="fy-board__reading" role="status">
            <Spinner size={14} />
            Reading the board…
          </p>
        )
      ) : view === 'kanban' ? (
        <div className={density === 'page' ? 'fy-board-kanban' : 'fy-board-side__kanban'} data-board-side-kanban="">
          {cards.lanes.map(lane => (
            <BoardLane
              category={lane.category}
              count={lane.cards.length}
              density={density}
              key={lane.key}
              name={lane.name}
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
    </section>
  );
}
