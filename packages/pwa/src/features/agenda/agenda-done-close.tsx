/**
 * THE PIECES OF "DONE · CLOSES &F12" that sit in the quick replies: the button, the checklist asked when several
 * cards are linked, and the line saying why a close did not go through. State lives in `use-done-close-flow.ts`.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { Check, LoaderCircle } from 'lucide-react';
import type { DoneCloseView } from './use-done-close-flow.ts';

/** The one button: an answer in the row, never a swipe. */
export function DoneCloseChip({ view, disabled }: { readonly view: DoneCloseView; readonly disabled: boolean }) {
  return (
    <button
      className="kt-btn fy-qr__chip"
      data-agenda-done-close=""
      disabled={disabled || view.busy}
      onClick={view.onTap}
      title={view.label}
      type="button"
    >
      {view.busy ? (
        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={13} />
      ) : (
        <Check aria-hidden="true" size={13} />
      )}
      <span className="fy-qr__label">{view.label}</span>
    </button>
  );
}

/** Which cards to close, all ticked; asked only when the item is linked to more than one. */
export function DoneCloseConfirm({ view }: { readonly view: DoneCloseView }) {
  const confirm = view.confirm;
  if (confirm === null) return null;
  return (
    <fieldset aria-label="Cards to close" className="fy-qr__confirm" data-agenda-done-close-confirm="">
      <legend className="fy-qr__confirm-title">Close these cards too?</legend>
      {confirm.cards.map(card => (
        <label className="fy-qr__confirm-card" key={card.ref.id}>
          <input
            checked={confirm.ticked.has(card.ref.id)}
            data-agenda-done-close-card={card.ref.id}
            disabled={view.busy}
            onChange={() => confirm.onToggle(card.ref.id)}
            type="checkbox"
          />
          <span>
            {formatTaskRef(card.ref)}
            {card.title === undefined ? '' : ` ${card.title}`}
          </span>
        </label>
      ))}
      <span className="fy-qr__confirm-actions">
        <button
          className="kt-btn fy-qr__chip"
          data-agenda-done-close-confirm-go=""
          data-variant="primary"
          disabled={view.busy || confirm.ticked.size === 0}
          onClick={confirm.onConfirm}
          type="button"
        >
          {view.busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={13} />
          ) : (
            <Check aria-hidden="true" size={13} />
          )}
          <span className="fy-qr__label">Close {confirm.ticked.size} and resolve</span>
        </button>
        <button
          className="fy-qr__dismiss"
          data-agenda-done-close-cancel=""
          disabled={view.busy}
          onClick={confirm.onCancel}
          type="button"
        >
          Cancel
        </button>
      </span>
    </fieldset>
  );
}

/** Why the last close did not go through: the item is still open. */
export function DoneCloseError({ view }: { readonly view: DoneCloseView }) {
  if (view.error === null) return null;
  return (
    <p className="fy-qr__error m-0" data-agenda-done-close-error="" role="alert">
      Not closed: {view.error}
    </p>
  );
}
