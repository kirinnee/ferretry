/**
 * THE SHARED CONTEXT MENU — one primitive, used by two surfaces.
 *
 * Ported from kteam `ui/src/components/ContextMenu.tsx`.
 *
 * The sidebar's session-row actions (right-click / long-press a teammate to
 * Stop, Resume, Migrate…) and the transcript's "Quote a selection" both open
 * THIS menu. It is written once: the two surfaces differ only in what TRIGGERS
 * it (a row press vs. a text selection) and what ITEMS it carries, both passed
 * in as props. Nothing here knows about sessions or quoting.
 *
 * WHAT IT OWES THE READER, and where each piece is:
 *   - POSITIONED ON SCREEN. Opens at the trigger point, but flips and clamps so
 *     it is never off the edge at 360px (clampMenuPosition, pure + tested).
 *   - KEYBOARD. Menu-button ARIA pattern: roving focus, Up/Down/Home/End move,
 *     Enter/Space activate, Escape closes, Tab closes. Focus lands on the first
 *     item on open and returns to the trigger on a keyboard dismiss.
 *   - ESCAPE IS A STACK. Shares the app's escape layers (`use-dialog-focus`) so
 *     a menu opened over a sheet takes Escape without closing the sheet under it.
 *   - DISMISSES on outside pointer, on any scroll, on resize, and on a route
 *     change (popstate) — a menu anchored to a point must not linger once that
 *     point moves or the page navigates.
 *   - THE NATIVE MENU IS NOT GLOBALLY SUPPRESSED. The trigger sites decide when
 *     to preventDefault the browser's own contextmenu; this component only draws
 *     the replacement once they ask for it.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isTopEscapeLayer, pushEscapeLayer } from '../hooks/use-dialog-focus.ts';
import { cn } from '../lib/class-names.ts';

export interface ContextMenuItem {
  readonly key: string;
  readonly label: string;
  /**
   * Compact secondary fact (such as a selected-target count). It stays beside
   * the label so a menu choice communicates its scope before activation.
   */
  readonly detail?: ReactNode;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  /** Destructive tone (Stop, Migrate). Colour is reinforcement — the word says it. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
}

export interface MenuSize {
  readonly width: number;
  readonly height: number;
}

export interface MenuViewport {
  readonly width: number;
  readonly height: number;
}

export interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * Keep an anchored menu fully on screen.
 *
 * Opens with its top-left at the anchor, but flips LEFT when it would overflow
 * the right edge and UP when it would overflow the bottom (so a press near a
 * corner opens back toward the middle rather than off-screen), then clamps to
 * `margin` from every edge as the final guarantee. A menu larger than the
 * viewport is pinned to the top-left margin rather than pushed off the top.
 * Pure so the placement is asserted without a DOM.
 */
export function clampMenuPosition(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: MenuViewport,
  margin = 8,
): MenuPosition {
  let left = anchor.x;
  let top = anchor.y;
  if (left + size.width + margin > viewport.width) left = anchor.x - size.width;
  if (top + size.height + margin > viewport.height) top = anchor.y - size.height;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  left = Math.min(Math.max(margin, left), maxLeft);
  top = Math.min(Math.max(margin, top), maxTop);
  return { left, top };
}

/**
 * Move the roving focus index to the next enabled item in `direction`, wrapping
 * at the ends. Returns the same index when every item is disabled. Pure so the
 * arrow-key contract is testable without a DOM.
 */
export function nextEnabledIndex(items: readonly ContextMenuItem[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return from;
  for (let step = 1; step <= items.length; step++) {
    const index = (from + direction * step + items.length * step) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return from;
}

/** First enabled item, or 0 when all are disabled. */
export function firstEnabledIndex(items: readonly ContextMenuItem[]): number {
  const index = items.findIndex(item => !item.disabled);
  return index < 0 ? 0 : index;
}

export interface ContextMenuProps {
  readonly open: boolean;
  readonly anchor: MenuAnchor;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
  readonly ariaLabel: string;
  /** The element that opened the menu; keyboard dismissal returns focus to it. */
  readonly triggerRef?: { current: HTMLElement | null };
  /** Coarse pointer: rows take the 44px touch floor. */
  readonly touch?: boolean;
}

export function ContextMenu({ open, anchor, items, onClose, ariaLabel, triggerRef, touch }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<MenuSize | null>(null);
  const [active, setActive] = useState(0);
  const layer = useRef<object>({});
  /**
   * True only when the close should hand focus back to the trigger — a keyboard
   * dismiss (Escape/Tab). An item that moves focus itself (Quote → composer) or
   * an outside tap must NOT yank it back.
   */
  const restoreOnClose = useRef(false);
  const restoreTarget = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  // Global dismissal + Escape stacking, live only while open.
  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isTopEscapeLayer(token)) return;
      event.stopPropagation();
      restoreOnClose.current = true;
      close();
    };
    const dismiss = () => close();
    document.addEventListener('keydown', onKey);
    // Capture, so a scroll in ANY inner scroller (the session list, the
    // transcript) dismisses — the menu is anchored to a point that just moved.
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('popstate', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('popstate', dismiss);
      release();
    };
  }, [open, close]);

  // Capture the opener and pick the first enabled item on each OPENING — where
  // an opening is (open, anchor point), not a render. A caller re-rendering with
  // a fresh `{x, y}` literal or a fresh `items` array must not re-pick the
  // active row, or the arrow keys would be undone under the reader's hands; so
  // the effect is keyed on a value that encodes exactly "which opening is this",
  // and `items` is read through a ref.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const anchorX = anchor.x;
  const anchorY = anchor.y;
  const opening = open ? `${anchorX},${anchorY}` : null;
  useLayoutEffect(() => {
    if (opening === null) return;
    restoreTarget.current = triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    restoreOnClose.current = false;
    setActive(firstEnabledIndex(itemsRef.current));
  }, [opening, triggerRef]);

  // Measure after every render, so a menu whose rows changed is re-clamped
  // rather than left at a stale size. Cheap, and the write is idempotent: the
  // previous size object is kept when nothing moved, so this cannot loop.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!open || !element) return;
    const next = { width: element.offsetWidth, height: element.offsetHeight };
    setSize(current => (current?.width === next.width && current.height === next.height ? current : next));
  });

  // The clamp itself is derived, not stored: position is a pure function of the
  // anchor, the measured size and the viewport, and deriving it during render is
  // what guarantees it is right in the same commit that paints the menu.
  const position =
    open && size && typeof window !== 'undefined'
      ? clampMenuPosition({ x: anchorX, y: anchorY }, size, { width: window.innerWidth, height: window.innerHeight })
      : null;
  const positioned = position !== null;

  // Move DOM focus to the active item once it is on screen (positioned). Keyed
  // on the boolean rather than on the derived object, which is new every render.
  useEffect(() => {
    if (!open || !positioned) return;
    const nodes = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    nodes?.[active]?.focus();
  }, [open, positioned, active]);

  // Return focus to the trigger on a keyboard dismiss only.
  useEffect(() => {
    if (open) return;
    if (!restoreOnClose.current) return;
    restoreOnClose.current = false;
    const target = restoreTarget.current;
    restoreTarget.current = null;
    if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
  }, [open]);

  if (!open) return null;

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    // The action decides where focus goes next (a sheet, the composer), so a
    // pointer/keyboard activation does not restore to the trigger.
    restoreOnClose.current = false;
    close();
    item.onSelect();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(index => nextEnabledIndex(items, index, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(index => nextEnabledIndex(items, index, -1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(firstEnabledIndex(items));
        break;
      case 'End':
        event.preventDefault();
        setActive(nextEnabledIndex(items, firstEnabledIndex(items), -1));
        break;
      case 'Tab':
        // A menu does not trap Tab; it closes and lets focus move on.
        event.preventDefault();
        restoreOnClose.current = true;
        close();
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        const item = items[active];
        if (item) activate(item);
        break;
      }
      default:
        break;
    }
  };

  return (
    <>
      {/*
        Outside-dismiss surface. A real button so a tap or a keyboard activation
        both close, and a reader meets something named. It does NOT restore
        focus to the trigger (an outside tap is not a keyboard dismiss).
      */}
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        onPointerDown={() => close()}
        onContextMenu={event => {
          event.preventDefault();
          close();
        }}
        className="fixed inset-0 z-50 cursor-default"
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        style={{
          left: position?.left ?? anchor.x,
          top: position?.top ?? anchor.y,
          visibility: positioned ? 'visible' : 'hidden',
        }}
        className="kt-panel fixed z-50 min-w-[196px] max-w-[min(280px,calc(100vw-16px))] overflow-hidden p-1 font-ui shadow-popover"
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            tabIndex={index === active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => activate(item)}
            onPointerEnter={() => !item.disabled && setActive(index)}
            className={cn(
              'flex w-full items-center gap-sm rounded-control px-cell-x text-left text-ui',
              touch ? 'min-h-[44px]' : 'min-h-[34px] py-1',
              'text-fg-soft hover:bg-surface-2 focus:bg-surface-2 focus:outline-none',
              item.danger && 'text-err hover:text-err focus:text-err',
              item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
            )}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail && <span className="mono shrink-0 text-meta text-muted">{item.detail}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
