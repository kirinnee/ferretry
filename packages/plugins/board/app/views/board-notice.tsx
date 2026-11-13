/**
 * A notice above the board (a move that did not go through, a machine that did not answer).
 *
 * On a wide screen it is a plain line of text, as it always was. On a phone it is ONE line with an
 * ellipsis and a dismiss button: a three-line warning box would push the cards a third of the way down
 * the screen. Tapping the text opens it to its full length, and tapping again folds it back.
 */

import { X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

export interface BoardNoticeProps {
  readonly children: ReactNode;
  /** The phone's one-line form, with tap-to-expand text. */
  readonly compact: boolean;
  /** Absent: the notice has no dismiss button (a wide screen's machine error). */
  readonly onDismiss?: () => void;
  readonly machine?: string;
}

export function BoardNotice({ children, compact, onDismiss, machine }: BoardNoticeProps) {
  const [open, setOpen] = useState(false);
  const dismiss =
    onDismiss === undefined ? null : (
      <button aria-label="Dismiss" className="fy-board__notice-x" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={12} />
      </button>
    );
  if (!compact) {
    return (
      <p className="fy-board__notice" data-machine={machine} role="status">
        <span>{children}</span>
        {dismiss}
      </p>
    );
  }
  return (
    <p
      className="fy-board__notice"
      data-compact=""
      data-machine={machine}
      data-open={open ? '' : undefined}
      role="status"
    >
      <button
        aria-expanded={open}
        className="fy-board__notice-text"
        onClick={() => setOpen(current => !current)}
        type="button"
      >
        {children}
      </button>
      {dismiss}
    </p>
  );
}
