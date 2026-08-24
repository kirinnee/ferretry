import { Badge, Button, type BadgeTone } from '../shell/primitives.tsx';
import type { SessionEventStreamStatus } from './session-event-stream-model.ts';

/**
 * The four states a subscription can be in, plus the one it can only be in by NOT EXISTING.
 *
 * `unavailable` is deliberately not a {@link SessionEventStreamStatus}: the model is not running, so
 * it cannot be the thing reporting this. It is the host's fact — there is no client yet, or the
 * carrier router walked and answered that this daemon cannot be reached — and it has to be sayable
 * because the alternative is the page holding whatever it said last. A route that tore its stream
 * down and then declined to open another one, while the chip still read `Live`, would be the exact
 * defect this component exists for, arrived at from the opposite direction.
 */
export type LiveStreamState = SessionEventStreamStatus | 'unavailable';

/**
 * The word on the chip. Two syllables at most, because this sits in the one compact row a phone
 * keeps, beside the pane openers.
 */
const LIVE_STREAM_LABEL: Record<LiveStreamState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Offline',
  unavailable: 'Unreachable',
};

/**
 * The sentence a screen reader hears, which is NOT the chip's word.
 *
 * A reader who cannot see the colour needs the consequence, not the label: "Offline" alone reads as
 * a broken workspace, and for the three stream failures the workspace is not broken — the carrier
 * still works, so the transcript keeps refreshing on its own timer and only the fast path is gone.
 *
 * `unavailable` IS THE ONE THAT MUST NOT SAY THAT, and the difference is not a nicety. The other
 * states are a lost SOCKET over a carrier that is fine. This one is the carrier itself: the host has
 * no client, or the router walked and found this daemon unreachable — which is the same road the
 * three-second poll takes, so it is failing too. Promising a timer refresh there would be telling a
 * reader their screen is current when nothing can reach the machine that would update it. It claims
 * only what is true: what is already rendered stays, and new activity needs the daemon back.
 */
const LIVE_STREAM_SENTENCE: Record<LiveStreamState, string> = {
  connecting: 'Live updates are connecting.',
  live: 'Live updates are connected.',
  reconnecting: 'Live updates dropped and are reconnecting. The transcript still refreshes on a timer.',
  disconnected: 'Live updates are disconnected. The transcript still refreshes on a timer.',
  unavailable:
    'Live updates are unavailable because this daemon cannot be reached. What is already on screen stays; new activity appears once it is reachable again.',
};

/** `pend`/`ok`/`warn`/`err`, so the states are the same tones every other surface uses. */
const LIVE_STREAM_TONE: Record<LiveStreamState, BadgeTone> = {
  connecting: 'pend',
  live: 'ok',
  reconnecting: 'warn',
  disconnected: 'err',
  unavailable: 'err',
};

/**
 * WHEN THE READER IS OFFERED THE CONTROL, and why not always.
 *
 * A reconnect is a teardown: it abandons whatever socket is open and starts the schedule over. On a
 * `live` stream that is strictly destructive, and on a first `connecting` attempt it would abandon
 * an attempt that has not had its chance yet. In the two failure states there is nothing left to
 * protect — one is waiting out a backoff window the reader can see is unnecessary, and the other has
 * stopped trying altogether — so the control appears exactly where it can only help.
 *
 * `unavailable` IS THE INTERESTING EXCLUSION. It looks like the state that most wants a Reconnect
 * button and is the one state where the button would be a lie: there is no subscription to restart,
 * because the host has none to give — no client, or a carrier that walked and cannot reach this
 * daemon. A control wired to a model that does not exist is a no-op dressed as a remedy, and a
 * reader who presses it twice and sees nothing learns less than one who was never offered it.
 */
const offersReconnect = (state: LiveStreamState): boolean => state === 'reconnecting' || state === 'disconnected';

export interface LiveStreamIndicatorProps {
  readonly status: LiveStreamState;
  /** Restarts the subscription immediately and restores the full retry budget. */
  readonly onReconnect: () => void;
}

/**
 * What the chip should read, from the host's two facts and the model's one.
 *
 * A PURE FUNCTION AND NOT REMEMBERED STATE, which is the whole fix. The route's effect declines to
 * subscribe when there is no client or no reachable carrier, and a `useState` holding the last
 * reported status simply KEEPS whatever it was — so a stream that went `live` and then lost its
 * carrier on a later walk left the page saying `Live` with no subscription behind it. Deriving the
 * answer from the same two values the effect gates on makes that disagreement unrepresentable.
 *
 * NOT-YET-MEASURED IS NOT UNREACHABLE. Before the first request has walked, the router answers
 * `undefined` rather than a verdict, and calling that `unavailable` would put "this daemon cannot be
 * reached" on screen for every session on the way in. That is `connecting`: no subscription yet, and
 * no finding that there cannot be one.
 */
export const liveStreamState = (
  subscribed: boolean,
  carrierRefused: boolean,
  status: SessionEventStreamStatus,
): LiveStreamState => {
  if (subscribed) return status;
  return carrierRefused ? 'unavailable' : 'connecting';
};

/**
 * Says out loud whether this session's live feed is actually alive.
 *
 * THE DEFECT THIS EXISTS FOR IS THAT A DEAD STREAM LOOKED IDENTICAL TO A QUIET ONE. Nothing on the
 * screen distinguished "the daemon has said nothing because nothing has happened" from "the socket
 * died twenty minutes ago and nobody noticed", and the three-second poll underneath meant the
 * transcript stayed right the whole time — so the page went on looking live forever. A reader who
 * could not tell the two apart also had no way to act on the difference, which is why the state and
 * the control ship together rather than the state alone.
 *
 * IT IS A LIVE REGION, AND A POLITE ONE. Losing a live feed is not an alert: the workspace still
 * works, and interrupting somebody mid-sentence to say the fast path got slower would be worse than
 * the defect. `role="status"` announces the transition once, when it happens, and says nothing at
 * all while the state holds.
 *
 * The visible word and the announced sentence deliberately differ — see {@link LIVE_STREAM_SENTENCE}
 * — so the chip is `aria-hidden` and the sentence is the only thing assistive technology reads.
 */
export function LiveStreamIndicator({ status, onReconnect }: LiveStreamIndicatorProps) {
  return (
    <div
      className="flex items-center gap-1.5"
      // A harness proves recovery against this rather than against copy, which changes for reasons
      // that have nothing to do with the socket.
      data-live-stream={status}
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{LIVE_STREAM_SENTENCE[status]}</span>
      <Badge aria-hidden="true" tone={LIVE_STREAM_TONE[status]}>
        {LIVE_STREAM_LABEL[status]}
      </Badge>
      {offersReconnect(status) ? (
        <Button data-live-stream-reconnect="" onClick={onReconnect} size="sm" type="button">
          Reconnect
        </Button>
      ) : null}
    </div>
  );
}
