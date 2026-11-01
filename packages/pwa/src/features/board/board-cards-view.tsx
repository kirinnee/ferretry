/**
 * THE TASKS TAB'S CARDS VIEW: this ferret's cards one at a time, with `‹ n of N ›` stepping through them.
 *
 * Only cards that need the owner are here (`awaitingOwner`): cards waiting for a try, then plans waiting for an OK.
 * Everything else — todo, in progress, in review, merged, closed — is on the Kanban and the List. A card waiting for a try
 * is the Inbox's own row (`ToTestList`): Done, Not good and Skip as buttons, and on a touch screen a swipe left (Done),
 * right (Not good, with the same reason box) or down (Skip, the next card) at once. A plan to approve is drawn by the host (`draw`), as in the Kanban and List.
 *
 * The place in the stack is kept as the card the reader was on, so a card that moves on (its verdict) leaves the reader
 * at the same place in the stack rather than jumping to the top.
 */

import { type ReactElement, useState } from 'react';
import { cardStack, type StackRank } from '../../lib/board-card-stack.ts';
import type { ChatCards } from '../../lib/board-chat.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';
import { withProjectName, withTaskName } from '../../lib/to-test-inbox.ts';
import { StackPager } from '../agenda/stack-pager.tsx';
import { type ToTestAnswers, ToTestList } from '../agenda/to-test-rows.tsx';

const RANK_WORDS: Readonly<Record<StackRank, string>> = {
  'to-test': 'To test',
  approve: 'To approve',
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
  taskNames,
  projectNames,
  toTestAnswers,
}: {
  readonly cards: ChatCards;
  readonly draw: (card: BoardCardOf) => ReactElement;
  readonly now: number;
  readonly onOpenCard: (card: BoardCardOf) => void;
  readonly taskNames: ReadonlyMap<string, string> | undefined;
  readonly projectNames: ReadonlyMap<string, string> | undefined;
  readonly toTestAnswers: ToTestAnswers | undefined;
}): ReactElement | null {
  const stack = cardStack(cards, now);
  const [place, setPlace] = useState<Place>({ key: null, index: 0 });
  if (stack.length === 0) {
    return (
      <p className="fy-board-empty" data-board-cards-empty="">
        Nothing is waiting on you. The Kanban and the List show the rest.
      </p>
    );
  }
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
        <ToTestList
          answers={toTestAnswers}
          now={now}
          onNavigate={() => onOpenCard(entry.card)}
          onSkip={index < stack.length - 1 ? () => go(index + 1) : undefined}
          rows={[withProjectName(withTaskName(entry.toTest, taskNames), projectNames)]}
        />
      ) : (
        draw(entry.card)
      )}
    </div>
  );
}
