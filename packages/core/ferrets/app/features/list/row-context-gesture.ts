/**
 * HOW A FERRET ROW OPENS ITS MENU.
 *
 * A row is a nav LINK, not selectable prose, so a held finger is free to mean "menu" here — unlike the transcript, where a
 * long-press is how a reader selects text. Three pointer stories have to land on the same menu:
 *
 *   MOUSE    — right-click, through the native `contextmenu` event.
 *   ANDROID  — also fires `contextmenu` on a long-press, so it shares that path.
 *   IOS      — no `contextmenu` at all, so a dwell timer is the only opener.
 *
 * The dwell timer is cancelled by a drift past {@link MOVE_CANCEL_PX}, because a finger that has started moving is scrolling
 * the list, not asking for a menu. And because a long-press ALSO produces a click, the gesture swallows the next click for
 * {@link CLICK_SUPPRESS_MS} — otherwise opening the menu would simultaneously navigate into the ferret sitting under it.
 *
 * KEYBOARD: the Menu key and Shift+F10 open it at the row, because a row is focusable and a menu only a pointer can open is
 * a feature the keyboard never gets. `onPress` tells the row a dwell is under way (and when it ended) so it can show the
 * press taking hold.
 *
 * Returns `undefined` when there is nothing to open — a host that draws no menu must leave the browser's own context menu
 * completely alone rather than swallow it.
 */

import { type KeyboardEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from 'react';

/** How long a finger must dwell before the row menu opens. */
export const LONG_PRESS_MS = 500;
/** A press that drifts more than this is a scroll, not a long-press — cancel. */
const MOVE_CANCEL_PX = 10;
/** After the menu opens from a press, swallow the click the same gesture fires. */
const CLICK_SUPPRESS_MS = 700;

interface PressPoint {
  readonly x: number;
  readonly y: number;
}

/** True when a press has drifted far enough to be a scroll rather than a dwell. */
export const cancelsRowLongPress = (start: PressPoint, point: PressPoint): boolean =>
  Math.abs(point.x - start.x) > MOVE_CANCEL_PX || Math.abs(point.y - start.y) > MOVE_CANCEL_PX;

/**
 * True while the click produced by the menu-opening gesture must be ignored. `firedAt` 0 is "no menu opened":
 * `performance.now()` also starts at zero, so without that case every click in the first 700ms of a page read as a
 * long-press's trailing tap and was swallowed.
 */
export const suppressesRowClick = (firedAt: number, now: number): boolean =>
  firedAt !== 0 && now - firedAt < CLICK_SUPPRESS_MS;

/** Menu key, or Shift+F10: the two keys every platform's own context menu opens on. */
export const opensContextMenuKey = (event: { readonly key: string; readonly shiftKey: boolean }): boolean =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);

/** What made the menu open: a right-click, a held finger, or the keyboard. */
export type RowOpenedBy = 'mouse' | 'touch' | 'keyboard';

export type OpenRowFor<Subject> = (
  subject: Subject,
  x: number,
  y: number,
  by: RowOpenedBy,
  trigger: HTMLElement,
) => void;

export interface RowContextGesture {
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useRowContextGesture<Subject>(
  open: OpenRowFor<Subject> | undefined,
  subject: Subject,
  onPress?: (pressing: boolean) => void,
): RowContextGesture | undefined {
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAt = useRef<PressPoint | null>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const firedAt = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startAt.current = null;
    pressRef.current?.(false);
  }, []);

  // A pending dwell timer that outlives the row would fire against an unmounted tree — rows unmount constantly as the
  // list refilters.
  useEffect(() => cancel, [cancel]);

  if (!open) return undefined;

  const fire = (x: number, y: number, by: RowOpenedBy, trigger: HTMLElement) => {
    firedAt.current = performance.now();
    open(subject, x, y, by, trigger);
  };

  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!opensContextMenuKey(event)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      fire(rect.left + Math.min(32, rect.width / 2), rect.bottom, 'keyboard', event.currentTarget);
    },
    // Right-click (mouse) and Android's long-press both arrive here.
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      cancel();
      fire(event.clientX, event.clientY, 'mouse', event.currentTarget);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // A mouse has right-click; only touch/pen need the dwell timer.
      if (event.pointerType === 'mouse') return;
      const trigger = event.currentTarget;
      const px = event.clientX;
      const py = event.clientY;
      // Clear a previous gesture BEFORE recording this one: `cancel` also clears `startAt`, so cancelling afterwards would
      // leave every dwell timer seeing no active press and no menu would ever open.
      cancel();
      startAt.current = { x: px, y: py };
      triggerEl.current = trigger;
      pressRef.current?.(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        pressRef.current?.(false);
        if (startAt.current && triggerEl.current) fire(px, py, 'touch', triggerEl.current);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = startAt.current;
      if (!start) return;
      if (cancelsRowLongPress(start, { x: event.clientX, y: event.clientY })) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Swallow the click a just-fired long-press produces, so it cannot navigate into the ferret while the menu is open
    // over it.
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (suppressesRowClick(firedAt.current, performance.now())) {
        event.preventDefault();
        event.stopPropagation();
        firedAt.current = 0;
      }
    },
  };
}
