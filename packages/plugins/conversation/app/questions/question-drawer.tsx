import { ChevronUp } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { PendingQuestion } from './question-form.tsx';
import './questions.css';

/**
 * THE QUESTION, COLLAPSED. A pending question never spills its whole form under the chat: by default only one line sits
 * above the composer ("● Ferret asked: Fix · Answer ▴"), a native button that opens the very same form, unchanged. A
 * click or Enter opens it, Escape (or the same button) folds it away again; answering removes the question as before.
 * The form is unmounted while folded, which is safe because it keeps its unsent answers in its draft store.
 */
export interface QuestionDrawerProps {
  /** Who is asking: the ferret's display name. */
  readonly agentName: string;
  /** What the line says the question is about: a header, or the question's own words. */
  readonly topic: string;
  /** The action the opened drawer offers; "Answer" for the form, "Details" for the damaged variant. */
  readonly action?: string;
  /** The region's accessible name once open. */
  readonly label: string;
  /** Drawn only while open. */
  readonly children: ReactNode;
  /** Marks the variant for tests and styles (`data-question-drawer="unavailable"`). */
  readonly variant?: 'question' | 'unavailable';
}

/** The words the one line names the question by: its first header, else its first question's text. */
export const questionTopic = (question: PendingQuestion): string => {
  const first = question.questions[0];
  const text = (first?.header ?? first?.question ?? '').trim();
  return question.questions.length > 1 ? `${text} (+${question.questions.length - 1})` : text;
};

export function QuestionDrawer({
  agentName,
  topic,
  action = 'Answer',
  label,
  children,
  variant = 'question',
}: QuestionDrawerProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    // The form that held focus is gone: hand focus back to the line that opened it.
    queueMicrotask(() => trigger.current?.focus());
  };
  // Escape anywhere in the open drawer (the form's fields included) folds it.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || !open) return;
    event.stopPropagation();
    close();
  };

  return (
    <section
      aria-label={label}
      className="fy-question-drawer"
      data-open={open ? 'true' : 'false'}
      data-question-drawer={variant}
      onKeyDown={onKeyDown}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="fy-question-drawer-line"
        onClick={() => (open ? close() : setOpen(true))}
        ref={trigger}
        type="button"
      >
        <span aria-hidden="true" className="fy-question-drawer-dot">
          ●
        </span>
        <span className="fy-question-drawer-text">
          <strong>{agentName}</strong> {variant === 'unavailable' ? 'has a question' : 'asked'}
          {topic === '' ? '' : `: ${topic}`}
        </span>
        <span className="fy-question-drawer-action">
          {open ? 'Close' : action}
          <ChevronUp aria-hidden="true" data-open={open ? 'true' : 'false'} size={14} />
        </span>
      </button>
      <div hidden={!open} id={panelId}>
        {open ? children : null}
      </div>
    </section>
  );
}
