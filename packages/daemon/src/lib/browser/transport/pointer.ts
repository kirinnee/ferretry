import type { BrowserInputEvent } from '@ferretry/protocol';

/** Where the pointer last was on one page, in that page's own coordinates. */
export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

type MouseInput = Extract<BrowserInputEvent, { kind: 'mouse' }>;

/**
 * The events a person's input becomes on the page, in order.
 *
 * A mouse is always somewhere before it presses: a page sees it ARRIVE (`mousemove`, `mouseover`) and then
 * press. A tap on a phone, or a click on a view that saw no movement first, reaches the daemon as a bare
 * press at a point the pointer never travelled to — which is not how any real pointer behaves. So a press
 * or a wheel away from where the pointer last was is preceded by one move to that point: the pointer really
 * is there, because the person put it there. A release is never preceded: it ends a press the pointer has
 * already arrived for, and anywhere it moved since was sent as the moves it was.
 *
 * Nothing is invented beyond that one move — no curve, no jitter, no delay. Each event still reaches Chrome
 * the moment it arrives, so its timing is the person's own.
 */
export function pointerSequence(
  last: PointerPosition | undefined,
  input: BrowserInputEvent,
): readonly BrowserInputEvent[] {
  if (input.kind !== 'mouse' || input.type === 'mouseMoved' || input.type === 'mouseReleased') return [input];
  if (last !== undefined && last.x === input.x && last.y === input.y) return [input];
  const arrival: MouseInput = {
    kind: 'mouse',
    type: 'mouseMoved',
    x: input.x,
    y: input.y,
    button: 'none',
    buttons: 0,
    modifiers: input.modifiers ?? 0,
  };
  return [arrival, input];
}

/** Where the pointer is after this input: a mouse event moves it, anything else leaves it be. */
export function pointerAfter(last: PointerPosition | undefined, input: BrowserInputEvent): PointerPosition | undefined {
  return input.kind === 'mouse' ? { x: input.x, y: input.y } : last;
}
