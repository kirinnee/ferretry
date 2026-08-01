/**
 * HOW A SESSION ROW OPENS ITS MENU. Ported from `useRowContextGesture` in
 * kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * A row is a nav LINK, not selectable prose, so a held finger is free to mean
 * "menu" here — unlike the transcript, where a long-press is how a reader
 * selects text. Three pointer stories have to land on the same menu:
 *
 *   MOUSE    — right-click, through the native `contextmenu` event.
 *   ANDROID  — also fires `contextmenu` on a long-press, so it shares that path.
 *   IOS      — no `contextmenu` at all, so a dwell timer is the only opener.
 *
 * The dwell timer is cancelled by a drift past {@link MOVE_CANCEL_PX}, because a
 * finger that has started moving is scrolling the fleet, not asking for a menu.
 * And because a long-press ALSO produces a click, the gesture swallows the next
 * click for {@link CLICK_SUPPRESS_MS} — otherwise opening the menu would
 * simultaneously navigate into the session sitting underneath it.
 *
 * The thresholds and both predicates live in `agent-sidebar-model.ts` so they
 * can be asserted without a pointer; this file is only the wiring.
 *
 * Returns `undefined` when there is nothing to open — a read-only connection
 * offers no actions, and a menu with no items must leave the browser's own
 * context menu completely alone rather than swallow it.
 */

import type { SessionView } from '@ferretry/protocol';
import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from 'react';
import { cancelsRowLongPress, LONG_PRESS_MS, suppressesRowClick } from './agent-sidebar-model.ts';

/** Asks the sidebar's single hosted menu to open for `view`, at viewport coordinates. */
export type OpenSessionMenu = (view: SessionView, x: number, y: number, trigger: HTMLElement) => void;

export interface RowContextGesture {
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void;
}

export function useRowContextGesture(
  open: OpenSessionMenu | undefined,
  view: SessionView,
): RowContextGesture | undefined {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAt = useRef<{ x: number; y: number } | null>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const firedAt = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startAt.current = null;
  }, []);

  // A pending dwell timer that outlives the row would fire against an unmounted
  // tree — rows unmount constantly as the fleet refilters.
  useEffect(() => cancel, [cancel]);

  if (!open) return undefined;

  const fire = (x: number, y: number, trigger: HTMLElement) => {
    firedAt.current = performance.now();
    open(view, x, y, trigger);
  };

  return {
    // Right-click (mouse) and Android's long-press both arrive here.
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      cancel();
      fire(event.clientX, event.clientY, event.currentTarget);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // A mouse has right-click; only touch/pen need the dwell timer.
      if (event.pointerType === 'mouse') return;
      const trigger = event.currentTarget;
      const px = event.clientX;
      const py = event.clientY;
      // Clear a previous gesture BEFORE recording this one: `cancel` also
      // clears `startAt`, so cancelling afterwards would leave every dwell
      // timer seeing no active press and no menu would ever open.
      cancel();
      startAt.current = { x: px, y: py };
      triggerEl.current = trigger;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (startAt.current && triggerEl.current) fire(px, py, triggerEl.current);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = startAt.current;
      if (!start) return;
      if (cancelsRowLongPress(start, { x: event.clientX, y: event.clientY })) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Swallow the click a just-fired long-press produces, so it cannot navigate
    // into the session while the menu is open over it.
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (suppressesRowClick(firedAt.current, performance.now())) {
        event.preventDefault();
        event.stopPropagation();
        firedAt.current = 0;
      }
    },
  };
}
