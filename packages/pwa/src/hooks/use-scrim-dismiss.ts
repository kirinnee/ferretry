import { type MouseEvent as ReactMouseEvent, useRef } from 'react';

export interface ScrimDismiss {
  readonly onPointerDown: () => void;
  readonly onPointerCancel: () => void;
  readonly onClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Props for a backdrop that closes on a tap that began ON it.
 *
 * A sheet opened by tapping a row elsewhere (the finder's result, a menu item)
 * mounts under the finger that opened it, and the click the browser synthesizes
 * from that same touch lands on the new backdrop — closing the sheet in the
 * frame it appeared. Such a click never had a pointerdown on the backdrop, so a
 * pointer-driven click (`detail > 0`) without one is refused. A keyboard or
 * assistive-technology activation reports `detail === 0` and always closes.
 */
export function useScrimDismiss(onClose: () => void): ScrimDismiss {
  const pressed = useRef(false);
  return {
    onPointerDown: () => {
      pressed.current = true;
    },
    onPointerCancel: () => {
      pressed.current = false;
    },
    onClick: event => {
      const began = pressed.current;
      pressed.current = false;
      if (began || event.detail === 0) onClose();
    },
  };
}
