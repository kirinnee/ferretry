/**
 * THE COMPOSER'S "+" MENU. What the reader sees after tapping "+" at the start of the message box.
 *
 * It replaces the shared context menu for this one job, because that menu is a pointer-anchored list
 * for right-clicks: it measured itself before it showed, dismissed on any `resize` or `scroll`, and
 * drew its rows as bare icons in a box. On a phone, tapping "+" with the keyboard open hides the
 * keyboard, the window resizes, and the old menu closed itself the moment it opened — the flicker.
 *
 * TWO SHAPES, ONE LIST. On a phone it is a bottom sheet: full width, large rows, over a scrim. On a
 * desktop it is a popover that sits ABOVE the composer, aligned to the "+", so it can never cover the
 * text being typed. Every row is a 44px-or-taller target with an icon, a plain label, and a one-line
 * hint saying what it takes.
 *
 * IT NEVER DISMISSES ITSELF FROM LAYOUT. Only a deliberate act closes it — a row, Escape, a tap on the
 * scrim, the Cancel button, or a second tap on "+". A resize or a scroll only re-places the popover.
 * It also mounts in one pass (no hidden measuring frame), so a tap opens it exactly once.
 */

import { Camera, MapPin, Paperclip } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { cn } from '../lib/class-names.ts';

type AddMenuActionKey = 'attach' | 'camera' | 'location';

export interface AddMenuAction {
  readonly key: AddMenuActionKey;
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
}

/** The rows the menu can offer, in order. `camera` and `location` appear only where they work. */
export const addMenuActions = (handlers: {
  readonly attach: () => void;
  readonly camera?: (() => void) | undefined;
  readonly location?: (() => void) | undefined;
}): readonly AddMenuAction[] => [
  {
    key: 'attach',
    label: 'Attach files',
    hint: 'Photos, screenshots, documents',
    icon: <Paperclip aria-hidden="true" size={20} />,
    onSelect: handlers.attach,
  },
  ...(handlers.camera === undefined
    ? []
    : [
        {
          key: 'camera' as const,
          label: 'Take photo',
          hint: 'Use the camera',
          icon: <Camera aria-hidden="true" size={20} />,
          onSelect: handlers.camera,
        },
      ]),
  ...(handlers.location === undefined
    ? []
    : [
        {
          key: 'location' as const,
          label: 'Share location',
          hint: 'Send where you are, with a map',
          icon: <MapPin aria-hidden="true" size={20} />,
          onSelect: handlers.location,
        },
      ]),
];

export interface ComposerAddMenuProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly actions: readonly AddMenuAction[];
  /** The "+" button: the popover aligns to it and focus returns to it. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** `sheet` on a phone, `popover` elsewhere. */
  readonly variant: 'sheet' | 'popover';
}

interface Placement {
  readonly left: number;
  readonly bottom: number;
}

const MARGIN = 8;
const POPOVER_WIDTH = 304;

/** Above the composer, aligned to the "+", clamped inside the viewport. Pure so it is asserted alone. */
export const popoverPlacement = (
  anchor: { readonly left: number },
  composerTop: number,
  viewport: { readonly width: number; readonly height: number },
  width = POPOVER_WIDTH,
): Placement => ({
  left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN)),
  bottom: Math.max(MARGIN, viewport.height - composerTop + MARGIN),
});

export function ComposerAddMenu({ open, onClose, actions, anchorRef, variant }: ComposerAddMenuProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Called BEFORE the effect below: showModal moves focus, and this hook must note the opener first.
  const dialogFocus = useDialogFocus(open, dialogRef, onClose, { autoFocus: false });

  // A modal <dialog> is the top layer: it needs no portal, sits above every stacking context the
  // composer lives in, and makes the page behind it inert while the menu is up.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (!dialog.open) dialog.showModal?.();
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, [open]);

  const place = useCallback((): void => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const composer = anchor.closest('form') ?? anchor;
    setPlacement(
      popoverPlacement(anchor.getBoundingClientRect(), composer.getBoundingClientRect().top, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [anchorRef]);

  // Placed before the first paint, so the popover never shows in the wrong spot; kept placed (never
  // closed) through the resizes a keyboard or an attachment tray causes.
  useLayoutEffect(() => {
    if (!open || variant !== 'popover') return;
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place, variant]);

  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => onClose();
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, [open, onClose]);

  if (!open) return null;

  const items = (): HTMLElement[] => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>): void => {
    dialogFocus.onKeyDown(event);
    if (event.defaultPrevented) return;
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? all.length - 1 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(all.length - 1);
        break;
      default:
    }
  };

  const sheet = variant === 'sheet';
  return (
    <dialog
      aria-label="Add to message"
      aria-modal="true"
      className={cn(
        'fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden border-0 bg-transparent p-0 text-fg',
        sheet ? 'backdrop:bg-scrim' : 'backdrop:bg-transparent',
      )}
      data-testid="composer-add-menu"
      data-variant={variant}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      onClose={event => {
        if (!event.currentTarget.open) onClose();
      }}
      onKeyDown={onKeyDown}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div
        className={cn(
          'fy-add-menu absolute border border-border bg-surface shadow-popover',
          sheet
            ? 'fy-add-menu-sheet inset-x-0 bottom-0 rounded-t-panel border-x-0 border-b-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]'
            : 'rounded-panel',
        )}
        style={
          sheet
            ? undefined
            : { left: placement?.left ?? MARGIN, bottom: placement?.bottom ?? MARGIN, width: POPOVER_WIDTH }
        }
      >
        {sheet ? (
          <>
            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-strong" />
            <p className="px-4 pt-2 pb-1 font-medium text-faint text-meta uppercase tracking-wide">Add to message</p>
          </>
        ) : null}
        <div
          aria-label="Add to message"
          className={cn('flex flex-col', sheet ? 'px-2' : 'p-1')}
          ref={menuRef}
          role="menu"
        >
          {actions.map(action => (
            <button
              className={cn(
                'flex w-full items-center gap-3 rounded-control px-2 text-left text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                sheet ? 'min-h-[56px] py-2' : 'min-h-[48px] py-1.5',
              )}
              key={action.key}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-border-soft bg-surface-2 text-muted">
                {action.icon}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block font-medium text-sm">{action.label}</span>
                <span className="block text-meta text-muted">{action.hint}</span>
              </span>
            </button>
          ))}
        </div>
        {sheet ? (
          <div className="px-2 pt-1">
            <button
              className="flex min-h-[48px] w-full items-center justify-center rounded-control border border-border-soft bg-surface-2 font-medium text-fg text-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
