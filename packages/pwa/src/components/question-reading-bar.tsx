import { Repeat, Square, Volume2 } from 'lucide-react';
import { useEffect } from 'react';

/**
 * THE CONTROLS OF A QUESTION BEING READ ALOUD (F137 slice 5, fix round 3; `docs/voice.md` › A question Live was
 * waiting on).
 *
 * A structured question replaces the composer — and the Live bar with it — so the retained reader
 * (`hooks/use-live-question-handoff.ts`) has no Live control to stop it. This bar stands in for them while the question
 * is being read, right above the form: the state in WORDS, a Stop and a Repeat (48 px on a phone, 44 on a computer), and
 * the keys written down. It mounts only while the reading is under way, so it also owns the page-level keys:
 *
 *   Space, Esc or S stop the reading; R reads it again. They run only while focus is not in a text field (the form's
 *   "Other" box keeps its own keys), never with ctrl, meta or alt held, never when something already handled the key,
 *   and Space leaves a focused button to press itself.
 *
 * It is a reader's controls and nothing else: there is no microphone here, no "listen", no send. The question is read
 * to the person and is never answerable by voice.
 */

export interface QuestionReadingBarProps {
  readonly layout: 'phone' | 'desktop';
  onStop(): void;
  onRepeat(): void;
}

const isTextField = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/** A control that already answers Enter and Space itself: handling them here too would act twice. */
const isActivatable = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('button, a[href], [role="button"]') !== null;

/** What a key does to a question being read, or null when it is none of this bar's business. */
export function questionReadingKeyAction(event: KeyboardEvent): 'stop' | 'repeat' | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  if (isTextField(event.target)) return null;
  switch (event.key) {
    case 'Escape':
    case 's':
    case 'S':
      return 'stop';
    case ' ':
    case 'Spacebar':
      return isActivatable(event.target) ? null : 'stop';
    case 'r':
    case 'R':
      return 'repeat';
    default:
      return null;
  }
}

export function QuestionReadingBar({ layout, onStop, onRepeat }: QuestionReadingBarProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = questionReadingKeyAction(event);
      if (action === null) return;
      event.preventDefault();
      if (action === 'stop') onStop();
      else onRepeat();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onStop, onRepeat]);

  return (
    <section
      aria-label="Reading the question"
      className={`fy-live fy-live-question fy-live--question-${layout}`}
      data-question-reading=""
      data-tone="active"
    >
      <div className="fy-live-question-words">
        <Volume2 aria-hidden="true" className="fy-live-question-icon" size={18} />
        <div>
          <p className="fy-live-state" data-question-reading-state="">
            Reading the question aloud
          </p>
          <p className="fy-live-detail">
            Nothing is listening. Answer below by hand
            {layout === 'desktop' ? ', or press Space to stop, R to hear it again.' : '.'}
          </p>
        </div>
      </div>
      <div className="fy-live-question-actions">
        <button aria-keyshortcuts="Space Escape S" className="fy-live-btn" onClick={onStop} type="button">
          <Square aria-hidden="true" size={15} />
          Stop reading
          {layout === 'desktop' ? <kbd className="fy-live-key">Space</kbd> : null}
        </button>
        <button aria-keyshortcuts="R" className="fy-live-btn" onClick={onRepeat} type="button">
          <Repeat aria-hidden="true" size={15} />
          Repeat
          {layout === 'desktop' ? <kbd className="fy-live-key">R</kbd> : null}
        </button>
      </div>
      <span aria-live="polite" className="fy-live-sr" role="status">
        Reading the question
      </span>
    </section>
  );
}
