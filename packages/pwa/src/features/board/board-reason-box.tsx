/**
 * THE ONE-LINE REASON A MOVE BACK NEEDS (`board-design.md` §2.9): "why is this going back?". The words go to
 * the ferret as a new ask, so the box will not submit empty, and a refusal from the daemon is shown in place
 * so the owner can fix the words and send again.
 */

import { MAX_BOARD_REASON_LENGTH } from '@ferretry/protocol';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

export interface BoardReasonBoxProps {
  /** What is being moved, e.g. `Move &F412 back to Implement`. */
  readonly heading: string;
  readonly busy: boolean;
  /** The last refusal, or `null`. */
  readonly error: string | null;
  readonly onSubmit: (reason: string) => void;
  readonly onCancel: () => void;
  /** The words on the buttons and the input; the defaults are the move-back box's. */
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly busyLabel?: string;
}

export function BoardReasonBox({
  heading,
  busy,
  error,
  onSubmit,
  onCancel,
  placeholder = 'Why is it going back? The ferret reads this.',
  submitLabel = 'Move back',
  busyLabel = 'Moving…',
}: BoardReasonBoxProps) {
  const [reason, setReason] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const errorId = useId();
  useEffect(() => input.current?.focus(), []);
  const trimmed = reason.trim();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (trimmed !== '' && !busy) onSubmit(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onCancel();
  };
  return (
    <form
      aria-labelledby={headingId}
      aria-modal="true"
      className="fy-board-reason"
      onKeyDown={onKeyDown}
      onSubmit={submit}
      role="dialog"
    >
      <p className="fy-board-reason__heading" id={headingId}>
        {heading}
      </p>
      <input
        aria-describedby={error === null ? undefined : errorId}
        aria-invalid={error !== null}
        aria-label="Reason"
        className="fy-board-reason__input"
        maxLength={MAX_BOARD_REASON_LENGTH}
        onChange={event => setReason(event.target.value)}
        placeholder={placeholder}
        ref={input}
        required
        type="text"
        value={reason}
      />
      {error === null ? null : (
        <p className="fy-board-reason__error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="fy-board-reason__actions">
        <button className="kt-btn" data-variant="ghost" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="kt-btn" data-variant="primary" disabled={trimmed === '' || busy} type="submit">
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
