/**
 * THE ADD TOAST: what one tap on Add just did, for as long as it is worth reading.
 *
 * It reuses the agenda undo toast's look (`fy-attn-undo`), but unlike that one nothing is held back:
 * the add has already happened on the machine, so Undo is a real second request (`undoQuickAdd`).
 * A note ("Already in …", "Taken back.") has no Undo and goes after a few seconds.
 *
 * It floats (`position: fixed`), so it renders into `document.body` and is not clipped by whatever
 * the row sits in. The sentence lives in an always-mounted polite live region; the ticking seconds
 * are visual only.
 */

import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { secondsLeft } from '../agenda/agenda-undo-toast.tsx';

const TICK_MS = 250;

export interface CatalogToast {
  readonly sentence: string;
  /** How long it shows, in milliseconds. */
  readonly lifetimeMs: number;
  /** Present when the toast carries Undo. */
  readonly onUndo?: () => void;
  readonly undoing?: boolean;
}

function Drain({ remainingMs }: { readonly remainingMs: number }) {
  const [duration] = useState(() => Math.max(0, remainingMs));
  return <span aria-hidden="true" className="fy-attn-undo__drain" style={{ animationDuration: `${duration}ms` }} />;
}

export interface CatalogAddToastProps {
  readonly toast: CatalogToast;
  readonly onDismiss: () => void;
  readonly clock?: () => number;
}

export function CatalogAddToast({ toast, onDismiss, clock = Date.now }: CatalogAddToastProps) {
  const [deadline] = useState(() => clock() + toast.lifetimeMs);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.lifetimeMs);
    const ticker = setInterval(() => setTick(tick => tick + 1), TICK_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(ticker);
    };
  }, [onDismiss, toast.lifetimeMs]);

  const { onUndo } = toast;
  return createPortal(
    <div className="fy-attn-undo kt-panel" data-catalog-toast="">
      <p className="fy-attn-undo__text" role="status">
        {toast.sentence}
      </p>
      {onUndo === undefined ? null : (
        <>
          <span aria-hidden="true" className="fy-attn-undo__count mono" data-catalog-toast-count="">
            {secondsLeft(deadline, clock())}s
          </span>
          <button
            aria-label={`Undo: ${toast.sentence}`}
            className="kt-btn kt-btn--sm fy-attn-undo__button"
            data-catalog-toast-undo=""
            disabled={toast.undoing === true}
            onClick={onUndo}
            type="button"
          >
            <Undo2 aria-hidden="true" size={14} />
            Undo
          </button>
          <Drain remainingMs={deadline - clock()} />
        </>
      )}
    </div>,
    document.body,
  );
}
