/**
 * "LIVE VOICE" FROM THE COMMAND PALETTE, without the palette knowing about a microphone.
 *
 * The palette offers the command on a chat page and dispatches this event; the composer's Live control
 * (`components/live-voice-control.tsx`), when it is mounted and may send, listens and toggles Live. Where
 * no control listens (a device that may not send, dictation off) the event does nothing — there is no
 * way to start Live from here that the Live button would not allow. The toggle runs inside the
 * keypress that chose the command, so the microphone prompt still belongs to a gesture.
 */

export const LIVE_VOICE_TOGGLE_EVENT = 'fy:live-voice-toggle';

export interface LiveCommandTarget {
  dispatchEvent(event: Event): boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Ask whichever Live control is mounted to toggle. */
export function requestLiveToggle(target: LiveCommandTarget): void {
  target.dispatchEvent(new Event(LIVE_VOICE_TOGGLE_EVENT));
}

/** Listen for the request; returns the unsubscribe. */
export function onLiveToggle(target: LiveCommandTarget, handler: () => void): () => void {
  target.addEventListener(LIVE_VOICE_TOGGLE_EVENT, handler);
  return () => target.removeEventListener(LIVE_VOICE_TOGGLE_EVENT, handler);
}
