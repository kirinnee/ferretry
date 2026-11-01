import { type CSSProperties, useRef } from 'react';
import type { ToTestCard } from '../../lib/to-test-inbox.ts';
import { useDeckRoom } from './agenda-swipe-deck.tsx';
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
  onClose,
}: {
  readonly row: ToTestCard;
  readonly index: number;
  readonly total: number;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onPrevious: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
  readonly onClose?: () => void;
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
      <ToTestList
        answers={answers}
        now={now}
        onClose={onClose}
        onNavigate={onNavigate}
        onSkip={onNext === undefined ? undefined : () => onNext()}
        pager={{ index, total, noun: 'card', onPrevious, onNext }}
        rows={[row]}
      />
    </section>
  );
}
