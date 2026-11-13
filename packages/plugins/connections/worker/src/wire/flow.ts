/** The subset of kernel packages/core/kernel/host/session/wire/flow.ts the relay worker uses; replace with a kernel export when approved. */
/**
 * Backpressure, as a fixed window that cannot be argued upwards.
 *
 * A rendezvous never queues. It forwards a frame the moment it arrives, or it ends the session —
 * so the only thing that can grow without bound is the socket buffer underneath it, and the only
 * way to bound that is to stop the sender. A sender may have {@link CREDIT_WINDOW_FRAMES} frames
 * outstanding; the receiver returns credit as it consumes them.
 *
 * The window is a **cap**, not a starting point. A grant can never raise the outstanding allowance
 * above the window, so a peer that grants four billion credits — by mistake, or to make its
 * counterpart flood the relay on its behalf — changes nothing. The bound is a property of this
 * code rather than of anyone's good behaviour.
 */

import { CREDIT_WINDOW_FRAMES } from './constants.ts';

/** What a sender, and the rendezvous enforcing on that sender, must agree about. */
export interface SendWindow {
  readonly sent: number;
  readonly allowed: number;
}

export function newSendWindow(): SendWindow {
  return { sent: 0, allowed: CREDIT_WINDOW_FRAMES };
}

export function maySend(window: SendWindow): boolean {
  return window.sent < window.allowed;
}

export function recordSent(window: SendWindow): SendWindow {
  return { ...window, sent: window.sent + 1 };
}

/** Apply a credit grant, clamped so the outstanding allowance never exceeds the window. */
export function grantCredit(window: SendWindow, frames: number): SendWindow {
  if (!Number.isSafeInteger(frames) || frames <= 0) return window;
  const ceiling = window.sent + CREDIT_WINDOW_FRAMES;
  return { ...window, allowed: Math.min(window.allowed + frames, ceiling) };
}
