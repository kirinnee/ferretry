/**
 * THE ONE "DONE ✓" CONTROL: drawn the same on a Table row, a card, and the card detail (where it is the primary
 * "Mark done"). Closed cards in the Archive wear "Reopen" instead. It only reports a press; the page decides what
 * a move means, so a reopen still opens the reason box.
 */

import { Check, RotateCcw } from 'lucide-react';
import { type BoardDone, doneLabel, doneTitle } from '../../lib/board-done.ts';

export interface BoardDoneActionProps {
  readonly done: BoardDone;
  /** The card's title, for the accessible name: "Mark Fix the tunnel done". */
  readonly title: string;
  readonly onPress: () => void;
  /** `primary` is the card detail's big button; `row` is the compact one on a Table row. */
  readonly size?: 'row' | 'primary';
  readonly touch?: boolean;
  readonly disabled?: boolean;
}

export function BoardDoneAction({
  done,
  title,
  onPress,
  size = 'row',
  touch = false,
  disabled = false,
}: BoardDoneActionProps) {
  const Icon = done.kind === 'reopen' ? RotateCcw : Check;
  const label = doneLabel(done, size === 'primary');
  return (
    <button
      aria-label={doneTitle(done, title)}
      className="fy-board-done"
      data-done={done.kind}
      data-size={size}
      data-touch={touch ? '' : undefined}
      disabled={disabled}
      onClick={event => {
        event.stopPropagation();
        onPress();
      }}
      title={doneTitle(done, title)}
      type="button"
    >
      <Icon aria-hidden="true" size={size === 'primary' ? 14 : 12} />
      {label}
    </button>
  );
}
