/**
 * The frame a LIST opened from the Actions menu is drawn in: a right-hand drawer on a desktop, a
 * full-screen sheet on a phone. A popover is the wrong frame for a list that can run to dozens of
 * rows — it has no header to close from and hangs off the button, so it ran past the bottom of the
 * screen over the conversation.
 *
 * MODAL, WITH A DIMMED BACKDROP, rather than shrinking the chat column. The side pane already claims
 * the right edge of the desktop and the chat column's width is negotiated with it
 * (`SIDE_PANE_MIN_CHAT_WIDTH`); a second thing resizing that column would fight it. A modal drawer is
 * one rule — "everything behind is paused" — so focus is trapped, Escape and a click on the backdrop
 * close it, and the composer cannot be half-covered because nothing behind is meant to be used.
 */

import { X } from 'lucide-react';
import { type ReactNode, useId, useRef } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';

export function ActionDrawer({
  title,
  heading,
  compact,
  top = 0,
  onClose,
  children,
}: {
  /** The accessible name and the close buttons' label: "Resolved Attention". */
  readonly title: string;
  /** The visible heading, when it says more than the name: "Resolved · 7". */
  readonly heading?: string;
  /** Phone layout: the whole screen, not a drawer. */
  readonly compact: boolean;
  /** Where a desktop drawer starts, in px from the top of the viewport — under the app header. */
  readonly top?: number;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  return (
    <div
      className="fy-action-drawer"
      data-compact={compact ? '' : undefined}
      data-session-action-drawer=""
      style={compact ? undefined : { paddingTop: top }}
    >
      <button
        aria-label={`Close ${title}`}
        className="fy-action-drawer__backdrop"
        data-session-action-drawer-backdrop=""
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="fy-action-drawer__panel kt-panel"
        onKeyDown={onKeyDown}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <header className="fy-action-drawer__head">
          <h2 className="fy-action-drawer__title" id={titleId}>
            {heading ?? title}
          </h2>
          <button
            aria-label={`Close ${title}`}
            className="fy-action-drawer__close kt-btn kt-btn--sm"
            data-session-action-drawer-close=""
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="fy-action-drawer__body" data-session-action-drawer-body="">
          {children}
        </div>
      </div>
    </div>
  );
}
