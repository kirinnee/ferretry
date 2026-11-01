import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';

/** The `‹ 3 of 7 ›` of a stack of cards: the agenda card's own header, and the chat task panel's. */
export function StackPager({
  index,
  total,
  noun = 'item',
  onPrevious,
  onNext,
}: {
  readonly index: number;
  readonly total: number;
  /** What is stepped through, for the buttons' names: "Previous item". */
  readonly noun?: string;
  readonly onPrevious: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
}): ReactElement {
  return (
    <>
      <button
        aria-label={`Previous ${noun}`}
        className="fy-item-view__step"
        disabled={onPrevious === undefined}
        onClick={onPrevious}
        type="button"
      >
        <ChevronLeft aria-hidden="true" size={18} />
      </button>
      <span className="fy-item-view__where" data-agenda-where="">
        {index + 1} of {total}
      </span>
      <button
        aria-label={`Next ${noun}`}
        className="fy-item-view__step"
        disabled={onNext === undefined}
        onClick={onNext}
        type="button"
      >
        <ChevronRight aria-hidden="true" size={18} />
      </button>
    </>
  );
}
