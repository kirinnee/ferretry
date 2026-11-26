/**
 * WHERE THE FINDER AND THE PROJECT LIST OPEN, on the New ferret page: a bottom sheet on a phone (the app's one modal
 * shell, portalled out of any transformed box), an in-flow panel under the field on a desktop. Closed it draws nothing,
 * so neither state moves the fields around it.
 *
 * On a desktop the panel is a real (non-modal) dialog: opening it moves focus to the control marked
 * `data-where-initial-focus` (else its first field), Escape closes it, and closing by ANY route returns focus to
 * whatever opened it. The phone's sheet is the shared BottomSheet, which owns those behaviours itself.
 */
import { BottomSheet, useLayoutMode } from '@ferretry/app/ui';
import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface WhereSurfaceProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function WhereSurface({ open, title, onClose, children }: WhereSurfaceProps) {
  const phone = useLayoutMode() === 'drawer';
  const headingId = useId();
  if (phone) {
    return createPortal(
      <BottomSheet
        id={`fy-where-${headingId.replace(/:/gu, '')}`}
        labelledBy={headingId}
        closeLabel={`Close: ${title}`}
        onClose={onClose}
        open={open}
        panelClassName="gap-sm p-md"
      >
        <h2 className="m-0 text-ui font-semibold text-fg" id={headingId}>
          {title}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto" data-where-surface="sheet">
          {children}
        </div>
      </BottomSheet>,
      document.body,
    );
  }
  if (!open) return null;
  return (
    <WherePanel headingId={headingId} onClose={onClose} title={title}>
      {children}
    </WherePanel>
  );
}

/** The desktop panel: mounted only while open, so mounting is "opened" and unmounting is "closed" by any route. */
function WherePanel({
  headingId,
  title,
  onClose,
  children,
}: {
  readonly headingId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    const target =
      element?.querySelector<HTMLElement>('[data-where-initial-focus]') ?? element?.querySelector<HTMLElement>('input');
    (target ?? element)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <section
      aria-labelledby={headingId}
      className="mt-2 rounded-panel border border-border-strong bg-surface p-panel"
      data-where-surface="panel"
      onKeyDown={onKeyDown}
      ref={panel}
      role="dialog"
      tabIndex={-1}
    >
      <div className="mb-2 flex items-center justify-between gap-sm">
        <h3 className="m-0 text-ui font-semibold text-fg" id={headingId}>
          {title}
        </h3>
        <button
          aria-label={`Close: ${title}`}
          className="inline-flex h-control-sm w-control-sm items-center justify-center rounded-control text-muted hover:text-fg"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      {children}
    </section>
  );
}
