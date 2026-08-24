import { Badge, Button, type BadgeTone } from '../shell/primitives.tsx';
import type { SessionEventStreamStatus } from './session-event-stream-model.ts';

/**
 * The word on the chip. Two syllables at most, because this sits in the one compact row a phone
 * keeps, beside the pane openers.
 */
const LIVE_STREAM_LABEL: Record<SessionEventStreamStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Offline',
};

/**
 * The sentence a screen reader hears, which is NOT the chip's word.
 *
 * A reader who cannot see the colour needs the consequence, not the label: "Offline" alone reads as
 * a broken workspace, and the workspace is not broken — the transcript keeps refreshing on its own
 * timer either way. Each sentence therefore says what stopped AND what still works, which is the
 * difference between an honest degraded state and an alarm.
 */
const LIVE_STREAM_SENTENCE: Record<SessionEventStreamStatus, string> = {
  connecting: 'Live updates are connecting.',
  live: 'Live updates are connected.',
  reconnecting: 'Live updates dropped and are reconnecting. The transcript still refreshes on a timer.',
  disconnected: 'Live updates are disconnected. The transcript still refreshes on a timer.',
};

/** `pend`/`ok`/`warn`/`err`, so the four states are the same four tones every other surface uses. */
const LIVE_STREAM_TONE: Record<SessionEventStreamStatus, BadgeTone> = {
  connecting: 'pend',
  live: 'ok',
  reconnecting: 'warn',
  disconnected: 'err',
};

/**
 * WHEN THE READER IS OFFERED THE CONTROL, and why not always.
 *
 * A reconnect is a teardown: it abandons whatever socket is open and starts the schedule over. On a
 * `live` stream that is strictly destructive, and on a first `connecting` attempt it would abandon
 * an attempt that has not had its chance yet. In both of the other two states there is nothing left
 * to protect — one is waiting out a backoff window the reader can see is unnecessary, and the other
 * has stopped trying altogether — so the control appears exactly where it can only help.
 */
const offersReconnect = (status: SessionEventStreamStatus): boolean =>
  status === 'reconnecting' || status === 'disconnected';

export interface LiveStreamIndicatorProps {
  readonly status: SessionEventStreamStatus;
  /** Restarts the subscription immediately and restores the full retry budget. */
  readonly onReconnect: () => void;
}

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
