/**
 * The dictation REVIEW MINI BOX — the finished transcript, held where the person can read it,
 * fix a word, and decide.
 *
 * NOTHING REACHES THE DRAFT WITHOUT INSERT. On Stop the hook parks the take as a `DictationReview`
 * and this box is the only door out: Insert puts the text where the composer's caret is NOW (typing
 * while the take was transcribing is preserved), Discard drops it. The draft is never replaced, and
 * nothing here can send a message.
 *
 * THE BOX OWNS ONE THING THE HOOK DOES NOT: the person's edits. The text is an inline editor, small,
 * auto-growing to a few lines (then it scrolls). When cleanup changed the words, a quiet two-way
 * switch shows the cleaned or the RAW transcript; each side keeps its own edits, and Insert takes
 * whichever is showing. When cleanup failed there is nothing to switch to — the box says so and
 * shows the raw words, which is all there is.
 *
 * KEYS, WHEN FOCUS IS IN THE TEXT: Enter or ⌘/Ctrl+Enter inserts, Escape discards, Shift+Enter is a
 * newline. The box never takes focus by itself: the composer may be where the person is typing, and
 * a mini box that stole the caret would eat their next word. The buttons are the path for everyone
 * else, and each is a 44px target.
 */

import { Check, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import type { DictationReview } from '../hooks/use-dictation.ts';
import { cn } from '../lib/class-names.ts';
import { Button } from '../shell/primitives.tsx';

/** The daemon words a reason in lower case without a stop; the box reads it as a sentence. */
const asSentence = (message: string): string => {
  const text = message.trim();
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
};

export type ReviewKeyAction = 'insert' | 'discard';

export interface ReviewKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  /** An input method is mid-composition: its Enter commits a candidate, it is not ours. */
  readonly isComposing: boolean;
}

/**
 * What a key does inside the review text. Pure so the whole map has a test: Enter inserts, a plain
 * Shift+Enter stays a newline, and a key pressed while an input method is composing is left alone.
 */
export function reviewKeyAction(event: ReviewKeyEvent): ReviewKeyAction | null {
  if (event.isComposing) return null;
  if (event.key === 'Escape') return 'discard';
  if (event.key === 'Enter' && !event.shiftKey) return 'insert';
  return null;
}

export type ReviewView = 'cleaned' | 'raw';

export interface DictationReviewBoxProps {
  readonly review: DictationReview;
  /** Insert the text as the person left it, at the composer's caret. */
  onInsert(text: string): void;
  onDiscard(): void;
  /** Throw this take away and record again. */
  onRetry(): void;
  /** Open this take's cleanup debug record. Given only while dictation debug is on and the record is still held. */
  onDetails?(): void;
}

const ACTION_CLASS = 'min-h-[44px] min-w-[44px] shrink-0 justify-center';

/** One segment of the cleaned/raw switch: quiet at rest, the chosen one carries the weight. */
function Segment({
  label,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'min-h-[44px] shrink-0 whitespace-nowrap rounded-control px-2 text-meta',
        selected ? 'bg-surface-2 font-semibold text-fg' : 'text-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}

/**
 * The editor and its footer. Remounted per take (the parent keys it on `review.id`), so a new take
 * never inherits the last one's edits or its cleaned/raw choice.
 */
export function DictationReviewBox({ review, onInsert, onDiscard, onRetry, onDetails }: DictationReviewBoxProps) {
  const cleanupChangedWords = review.cleaned !== review.raw;
  const [view, setView] = useState<ReviewView>('cleaned');
  const [edits, setEdits] = useState<Record<ReviewView, string>>({ cleaned: review.cleaned, raw: review.raw });
  const text = edits[view];
  const empty = text.trim() === '';

  const insert = (): void => {
    if (!empty) onInsert(text);
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 px-2 py-1.5">
      {review.enhancementError ? (
        <p role="status" data-review-notice="cleanup-failed" className="m-0 text-meta leading-base text-warn">
          Cleanup failed, so this is the raw transcript. {asSentence(review.enhancementError.message)}
        </p>
      ) : null}

      <div className="max-h-[7.5rem] min-w-0 overflow-y-auto rounded-control">
        {/* A mirror sizes the grid cell, so the textarea grows with its text without any measuring code. */}
        <div className="grid">
          <div
            aria-hidden="true"
            className="kt-input invisible col-start-1 row-start-1 whitespace-pre-wrap break-words !min-h-0"
          >
            {`${text}\n`}
          </div>
          <textarea
            aria-label="Dictated text — edit it, then insert"
            aria-keyshortcuts="Enter Escape"
            data-review-text={view}
            className="kt-input col-start-1 row-start-1 resize-none overflow-hidden !min-h-0 break-words"
            rows={1}
            spellCheck
            value={text}
            onChange={event => setEdits(current => ({ ...current, [view]: event.target.value }))}
            onKeyDown={event => {
              const action = reviewKeyAction({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
              });
              if (action === null) return;
              event.preventDefault();
              // Escape is the box's own: it must not also reach a surface behind it.
              event.stopPropagation();
              if (action === 'insert') insert();
              else onDiscard();
            }}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-xs">
        {cleanupChangedWords ? (
          <fieldset className="m-0 flex shrink-0 items-center border-0 p-0">
            <legend className="sr-only">Which version to insert</legend>
            <Segment label="Cleaned" selected={view === 'cleaned'} onSelect={() => setView('cleaned')} />
            <Segment label="Raw" selected={view === 'raw'} onSelect={() => setView('raw')} />
          </fieldset>
        ) : null}
        {onDetails ? (
          <button
            type="button"
            data-review-details
            onClick={onDetails}
            className="min-h-[44px] shrink-0 px-2 text-meta text-accent underline underline-offset-2 hover:text-fg"
          >
            Details
          </button>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-xs">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={ACTION_CLASS}
            aria-label="Record again"
            title="Throw this away and record again"
            onClick={onRetry}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(ACTION_CLASS, 'px-2')}
            aria-label="Discard dictation"
            title="Discard — Esc"
            onClick={onDiscard}
          >
            <X size={15} aria-hidden="true" />
            <span className="ml-1 hidden text-ui min-[480px]:inline">Discard</span>
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className={cn(ACTION_CLASS, 'px-2')}
            aria-label="Insert at the cursor"
            title="Insert at the cursor — Enter"
            disabled={empty}
            onClick={insert}
          >
            <Check size={15} aria-hidden="true" />
            <span className="ml-1 text-ui">Insert</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
