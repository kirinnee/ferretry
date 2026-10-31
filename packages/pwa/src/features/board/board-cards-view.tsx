/**
 * THE TASKS TAB'S CARDS VIEW: this ferret's cards one at a time, with `‹ n of N ›` stepping through them.
 *
 * The order is `cardStack`'s: cards waiting for a try, then cards waiting on the owner, then the rest. A card waiting
 * for a try is the Inbox's own row (`ToTestList`): Done and Not good as buttons, and on a touch screen a swipe right or
 * left at once, with the same reason box. Any other card is drawn by the host (`draw`), as in the Kanban and List.
 *
 * The place in the stack is kept as the card the reader was on, so a card that moves on (its verdict) leaves the reader
 * at the same place in the stack rather than jumping to the top.
 */

import { type ReactElement, useState } from 'react';
import { StackPager } from '../agenda/stack-pager.tsx';
import { ToTestList, type ToTestAnswers } from '../agenda/to-test-rows.tsx';
import { type StackRank, cardStack } from '../../lib/board-card-stack.ts';
import type { ChatCards } from '../../lib/board-chat.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';

const RANK_WORDS: Readonly<Record<StackRank, string>> = {
  'to-test': 'To test',
  waiting: 'Waiting on you',
  rest: 'Other',
};

interface Place {
  readonly key: string | null;
  readonly index: number;
}

export function BoardCardsView({
  cards,
  draw,
  now,
  onOpenCard,
  toTestAnswers,
}: {
  readonly cards: ChatCards;
  readonly draw: (card: BoardCardOf) => ReactElement;
  readonly now: number;
  readonly onOpenCard: (card: BoardCardOf) => void;
  readonly toTestAnswers: ToTestAnswers | undefined;
}): ReactElement | null {
  const stack = cardStack(cards);
  const [place, setPlace] = useState<Place>({ key: null, index: 0 });
  if (stack.length === 0) return null;
  const found = place.key === null ? -1 : stack.findIndex(entry => entry.card.key === place.key);
  const index = found >= 0 ? found : Math.min(place.index, stack.length - 1);
  const entry = stack[index];
  if (entry === undefined) return null;
  const go = (to: number): void => setPlace({ key: stack[to]?.card.key ?? null, index: to });
  return (
    <div className="fy-board-cards" data-board-cards="">
      <div className="fy-board-cards__bar">
        <span className="fy-board-cards__rank" data-board-cards-rank="" data-rank={entry.rank}>
          {RANK_WORDS[entry.rank]}
        </span>
        <div className="fy-board-cards__pager">
          <StackPager
            index={index}
            noun="card"
            onNext={index < stack.length - 1 ? () => go(index + 1) : undefined}
            onPrevious={index > 0 ? () => go(index - 1) : undefined}
            total={stack.length}
          />
        </div>
      </div>
      {entry.toTest !== null && toTestAnswers !== undefined ? (
        <ToTestList answers={toTestAnswers} now={now} onNavigate={() => onOpenCard(entry.card)} rows={[entry.toTest]} />
      ) : (
        draw(entry.card)
      )}
    </div>
  );
}
