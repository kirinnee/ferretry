/**
 * THE LIVE ACTIVITY LINE — the bottom of the conversation while an agent works.
 *
 * It says what the harness itself says: Claude's `Pontificating… 42s · ↓ 3.1k tokens`, Codex's
 * `Working… 6m52s`. Those words come off the agent's own pane (`lib/pane-activity.ts`), read while
 * the session is live and the page is visible, and never for a finished or parked one. A capture is
 * a local terminal read — it starts no turn and spends no tokens.
 *
 * THE SAME READ DECIDES WHETHER THE LINE SHOWS AT ALL. A frame with no status line is an agent at
 * its prompt, and `lib/session-activity.ts` turns that into "ready" — which is how a brand-new
 * session, `running` from the moment it launched, stops showing a spinner nobody started.
 *
 * WHEN THE PANE CANNOT BE READ the line still tells the truth, in fewer words: the daemon's own
 * activity sentence, or `Working…`. A failed read is not shown as an error. The line is a courtesy,
 * the transcript underneath is the record, and a red banner over a working session because one
 * capture failed would be a louder lie than a vaguer sentence.
 *
 * THE CLOCK AND THE COUNTS ARE LIVE. The pane is read every few seconds, so its printed `42s` could
 * only ever move in jumps. The clock instead runs in this page from the turn's own start — the
 * daemon's `turnStateAt`, the one whose-turn boundary — and ticks on each whole second. The token
 * counts come from the daemon's `live` frames (`?live=1` on the session's event stream, sampled
 * twice a second from the transcript's usage records and the pane's own counter) and from this
 * page's pane read, whichever is further along, and count up to each new reading.
 */

import type { SessionLiveActivity } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import { type LiveScheduler, useCountUp, useLiveElapsed } from '../hooks/use-live-counter.ts';
import { formatElapsedSeconds, formatTokenCount, liveReadout } from '../lib/live-counter.ts';
import { type PaneActivity, paneActivityDetail, parsePaneActivity } from '../lib/pane-activity.ts';
import { type PaneReading, UNREAD_PANE } from '../lib/session-activity.ts';
import { Spinner } from './spinner.tsx';
import { thinkingActivityLabel } from './thinking-indicator.tsx';

/** Reads the agent's pane as it is right now. */
export type PaneFrameReader = (signal: AbortSignal) => Promise<string>;

/** Often enough that the harness's own clock reads as moving, rarely enough to be cheap. */
const PANE_ACTIVITY_INTERVAL_MS = 2_500;

const documentHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * The agent's pane as last read while `active`: whether a frame was read, and the harness's live
 * status line in it. Unread while inactive, before the first read lands, and after a failed read.
 *
 * One read in flight at a time: the next is scheduled only after the previous one settles, so a slow
 * daemon slows the line down rather than stacking captures behind it. Turning inactive aborts the
 * read in flight and clears the line in the same commit.
 */
export function usePaneActivity(
  read: PaneFrameReader | undefined,
  active: boolean,
  intervalMs = PANE_ACTIVITY_INTERVAL_MS,
): PaneReading {
  const [reading, setReading] = useState<PaneReading>(UNREAD_PANE);
  useEffect(() => {
    setReading(UNREAD_PANE);
    if (!active || read === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (!documentHidden()) {
        try {
          const frame = await read(controller.signal);
          if (!controller.signal.aborted) setReading({ read: true, activity: parsePaneActivity(frame) });
        } catch {
          if (!controller.signal.aborted) setReading(UNREAD_PANE);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, intervalMs, read]);
  return reading;
}

export interface LiveActivityLineProps {
  /** The harness's own line, when the pane showed one. */
  readonly activity: PaneActivity | null;
  /** The daemon's activity sentence, used when the pane said nothing readable. */
  readonly fallback?: string | null;
  /** The working turn's start (`state.turnStateAt`): the clock runs from here. */
  readonly turnStartedAt?: string | null;
  /** The latest `live` sample off the session's stream. */
  readonly live?: SessionLiveActivity | null;
  /** Injectable so a suite drives the clock; the browser's own otherwise. */
  readonly scheduler?: LiveScheduler;
  /** Whether the line holds still; absent, the transcript's shared selection hold decides. */
  readonly hold?: boolean;
}

/** A count as printed, `—` when nobody measured it. */
const shownCount = (tokens: number | null): string => (tokens === null ? '—' : formatTokenCount(tokens));

/**
 * The line itself. With a turn boundary from the daemon, the clock ticks client-side from that
 * instant — every second, on the second — and the token counts count up to each new reading, never
 * down; `—` is printed for a count nobody measured. Without one (an older daemon), it prints the
 * harness's own words as the pane last showed them.
 *
 * The ticking figures are hidden from assistive technology: a status region re-announced every
 * second would talk over everything else. The verb is the announcement.
 */
export function LiveActivityLine({
  activity,
  fallback,
  turnStartedAt = null,
  live = null,
  scheduler,
  hold,
}: LiveActivityLineProps) {
  const readout = liveReadout({ turnStartedAt, live, pane: activity });
  const options = { ...(scheduler === undefined ? {} : { scheduler }), ...(hold === undefined ? {} : { hold }) };
  const seconds = useLiveElapsed(readout.startedAt, options);
  const resetKey = turnStartedAt ?? '';
  const output = useCountUp(readout.outputTokens, { ...options, resetKey });
  const input = useCountUp(readout.inputTokens, { ...options, resetKey });
  const verb = readout.verb ?? thinkingActivityLabel(fallback);
  const timed = readout.startedAt !== null;
  const detail = timed
    ? `${formatElapsedSeconds(seconds ?? 0)} · ↓ ${shownCount(output)} · ↑ ${shownCount(input)}`
    : activity === null
      ? ''
      : paneActivityDetail(activity);
  return (
    <div
      className="fy-live-activity"
      data-activity-harness={activity?.harness ?? 'unknown'}
      data-transcript-density="chrome"
      role="status"
    >
      <Spinner />
      <span className="min-w-0 truncate">
        <b>{verb}</b>
        {detail === '' ? null : (
          <span
            aria-hidden="true"
            className="fy-live-activity-detail"
            data-live-elapsed={timed ? String(seconds ?? 0) : undefined}
            data-live-input={timed && input !== null ? String(input) : undefined}
            data-live-output={timed && output !== null ? String(output) : undefined}
          >
            {' '}
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}
