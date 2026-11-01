import { type CSSProperties, useRef } from 'react';
import type { ToTestCard } from '../../lib/to-test-inbox.ts';
import { useDeckRoom } from './agenda-swipe-deck.tsx';
import { StackPager } from './stack-pager.tsx';
import { type ToTestAnswers, ToTestList } from './to-test-rows.tsx';

/** The card-mode page's own bottom padding (agenda-inbox.css), left clear so the page never scrolls for the box. */
const PAGE_FOOT_PX = 12;

/** One card waiting for a try, as a step of the Inbox's quick-answer run: where it is in the run, then the shared row. */
export function ToTestStep({
  row,
  index,
  total,
  answers,
  now,
  onNavigate,
  onPrevious,
  onNext,
}: {
  readonly row: ToTestCard;
  readonly index: number;
  readonly total: number;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onPrevious: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
}) {
  const box = useRef<HTMLElement>(null);
  // The box takes all the room down to the bottom of the page (the tab bar's top on a phone), measured as the deck does.
  const room = useDeckRoom(box, row.key, PAGE_FOOT_PX);
  return (
    <section
      aria-label="Card to test"
      className="fy-inbox-step"
      data-inbox-open-to-test={row.key}
      ref={box}
      style={room === null ? undefined : ({ '--deck-room': `${room}px` } as CSSProperties)}
    >
      <div className="fy-inbox-step__bar">
        <span className="fy-inbox-step__rank">Ready to test</span>
        <div className="fy-inbox-step__pager">
          <StackPager compact index={index} noun="card" onNext={onNext} onPrevious={onPrevious} total={total} />
        </div>
      </div>
      <ToTestList
        answers={answers}
        now={now}
        onNavigate={onNavigate}
        onSkip={onNext === undefined ? undefined : () => onNext()}
        rows={[row]}
      />
    </section>
  );
}
