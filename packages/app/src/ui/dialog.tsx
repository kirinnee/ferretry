/**
 * THE DIALOG: the app's one CENTRED modal (`BottomSheet` is the one that slides up from the edge). Focus trap, Escape,
 * focus back to whatever opened it (all `useDialogFocus`), the page behind made `inert` while it is open, and ONE scroll
 * container, the body, that shows a scroll bar only when its content overflows (`dialog.css` owns the geometry).
 *
 * It is drawn in `document.body`, so no ancestor's `overflow` or `transform` can clip or move it, and it stays part of the
 * caller's React tree, so the caller's state survives. It knows no domain words: a caller gives it a title (or an
 * `ariaLabel`), a body and, optionally, a footer.
 */
import { X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from './hooks/use-dialog-focus.ts';
import { useScrimDismiss } from './hooks/use-scrim-dismiss.ts';
import { cn } from './lib/class-names.ts';

interface DialogBase {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Buttons along the foot, outside the scrolling body. */
  readonly footer?: ReactNode;
  /** When given, the header carries a close button with these words. A dialog with a Cancel of its own leaves it out. */
  readonly closeLabel?: string;
  /** `body` (default): the body scrolls. `content`: the body clips and a child owns the one scroller (a search box above a list). */
  readonly scroller?: 'body' | 'content';
  /** A CSS length: the widest the panel gets (still never over 92 vw). */
  readonly width?: string;
  /** Tailwind's z class; dialogs are z-50. A dialog opened from inside another passes a higher one. */
  readonly zIndexClass?: string;
  readonly className?: string;
}
/** A dialog is named by a visible title or, failing that, an `ariaLabel`; never by neither. */
export type DialogProps = DialogBase &
  (
    | { readonly title: string; readonly ariaLabel?: string }
    | { readonly title?: undefined; readonly ariaLabel: string }
  );

/** Marks every other top-level element of the page `inert` while `host` is open, and undoes exactly what it marked. */
function useInertBackground(open: boolean, host: { readonly current: HTMLElement | null }): void {
  // A LAYOUT effect: its cleanup runs before `useDialogFocus` gives the focus back, and a focus call on an element that is
  // still inert is refused.
  useLayoutEffect(() => {
    if (!open) return;
    const marked: Element[] = [];
    for (const child of document.body.children) {
      if (child === host.current || child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      marked.push(child);
    }
    return () => {
      for (const child of marked) child.removeAttribute('inert');
    };
  }, [open, host]);
}

export function Dialog({
  open,
  onClose,
  title,
  ariaLabel,
  children,
  footer,
  closeLabel,
  scroller = 'body',
  width,
  zIndexClass = 'z-50',
  className,
}: DialogProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(open, panelRef, onClose);
  const scrim = useScrimDismiss(onClose);
  useInertBackground(open, hostRef);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className={cn('fy-dialog kt-overlay', zIndexClass)} ref={hostRef}>
      <div aria-hidden="true" className="fy-dialog__scrim" {...scrim} />
      <div
        aria-label={title === undefined ? ariaLabel : undefined}
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-modal="true"
        className={cn('kt-panel fy-dialog__panel', className)}
        onKeyDown={onKeyDown}
        ref={panelRef}
        role="dialog"
        style={width === undefined ? undefined : ({ '--dialog-width': width } as CSSProperties)}
        tabIndex={-1}
      >
        {title === undefined && closeLabel === undefined ? null : (
          <div className="fy-dialog__head">
            {title === undefined ? (
              <span />
            ) : (
              <h2 className="fy-dialog__title" id={titleId}>
                {title}
              </h2>
            )}
            {closeLabel === undefined ? null : (
              <button aria-label={closeLabel} className="fy-dialog__close" onClick={onClose} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            )}
          </div>
        )}
        <div className="fy-dialog__body" data-dialog-body="" data-scroller={scroller}>
          {children}
        </div>
        {footer === undefined ? null : <div className="fy-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
