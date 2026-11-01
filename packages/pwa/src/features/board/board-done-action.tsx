/**
 * THE ONE "DONE ✓" CONTROL: drawn the same on a Table row, a card, and the card detail (where it is the primary
 * "Mark done"). Closed cards in the Archive wear "Reopen" instead. It only reports a press; the page decides what
 * a move means, so a reopen still opens the composer.
 *
 * While its move is in flight it is `pending`: the icon turns into a spinner of the same size and the label stays,
 * so the button keeps its width and nothing slides under the next tap; it is disabled until the move settles.
 */

import { ArrowRight, Check, RotateCcw } from 'lucide-react';
import type { ComponentType } from 'react';
import { Spinner } from '../../components/spinner.tsx';
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
  /** This control's move is in flight: a spinner where the icon was, and no second press. */
  readonly pending?: boolean;
  /** A verdict's "Done →": the arrow follows the label, on the side every Done sits (right), where a lone Done wears its tick before it. */
  readonly arrow?: boolean;
}

/** An answer's icon, or a spinner of the same size while its move is in flight. */
export function AnswerIcon({
  icon: Icon,
  size,
  pending,
}: {
  readonly icon: ComponentType<{ readonly 'aria-hidden'?: 'true'; readonly size?: number }>;
  readonly size: number;
  readonly pending: boolean;
}) {
  return pending ? (
    <Spinner className="fy-board-answer-spinner" size={size} />
  ) : (
    <Icon aria-hidden="true" size={size} />
  );
}

export function BoardDoneAction({
  done,
  title,
  onPress,
  size = 'row',
  touch = false,
  disabled = false,
  pending = false,
  arrow = false,
}: BoardDoneActionProps) {
  const label = doneLabel(done, size === 'primary');
  const iconSize = size === 'primary' ? 14 : 12;
  const useArrow = arrow && done.kind !== 'reopen';
  return (
    <button
      aria-busy={pending}
      aria-label={doneTitle(done, title)}
      className="fy-board-done"
      data-done={done.kind}
      data-pending={pending ? '' : undefined}
      data-size={size}
      data-touch={touch ? '' : undefined}
      disabled={disabled || pending}
      onClick={event => {
        event.stopPropagation();
        onPress();
      }}
      title={doneTitle(done, title)}
      type="button"
    >
      {useArrow ? null : (
        <AnswerIcon icon={done.kind === 'reopen' ? RotateCcw : Check} pending={pending} size={iconSize} />
      )}
      <span className="fy-board-done__label">{label}</span>
      {useArrow ? <AnswerIcon icon={ArrowRight} pending={pending} size={iconSize} /> : null}
    </button>
  );
}
