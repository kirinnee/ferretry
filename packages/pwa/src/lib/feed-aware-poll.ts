/**
 * A POLL THAT STANDS BACK WHILE THE DAEMON IS TELLING US WHAT CHANGED.
 *
 * The session page holds one live subscription to the session's journal (`/v1/events`), and the
 * journal already says when a surface was opened, handed over or taken back. A list read every ten
 * seconds beside it re-asks a question the feed has just answered — measured on an idle session page
 * over the relay, those re-reads were most of its traffic. So a read built on this:
 *
 *   * reads at once, and again soon after any feed event that may have moved its answer (a burst of
 *     events is one read, after `settleMs`);
 *   * while the feed is LIVE, polls only as a slow safety net (`liveEveryMs`), for what the journal
 *     does not record — a shell that exits on its own, a page the person closed elsewhere;
 *   * while there is no feed, or it is not live, polls at its old cadence (`everyMs`), so a dropped
 *     feed makes the screen as fresh as it always was rather than stale;
 *   * never reads while the tab is hidden: the tick is noted, and one read is made when it is shown.
 *
 * A change of liveness re-arms the timer at the new cadence; it does not read by itself, because a
 * feed that comes back resumes from its cursor and replays what it missed, and those events read.
 */

import type { FyEvent } from '@ferretry/protocol';

/** The session feed as a poller sees it: its events and, where the host knows it, whether it is live. */
export interface LiveFeedSignal {
  readonly subscribe: (listener: (event: FyEvent) => void) => () => void;
  readonly isLive?: () => boolean;
  readonly subscribeLive?: (listener: (live: boolean) => void) => () => void;
}

/** Timers and the page's visibility, injectable so a suite drives both. */
export interface FeedAwarePollEnvironment {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly hidden: () => boolean;
  readonly onVisible: (listener: () => void) => () => void;
}

export const browserFeedAwarePollEnvironment: FeedAwarePollEnvironment = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  hidden: () => globalThis.document?.visibilityState === 'hidden',
  onVisible: listener => {
    const changed = (): void => {
      if (globalThis.document?.visibilityState !== 'hidden') listener();
    };
    globalThis.document?.addEventListener('visibilitychange', changed);
    return () => globalThis.document?.removeEventListener('visibilitychange', changed);
  },
};

/** How long a burst of feed events is let settle before the one read it asks for. */
export const FEED_EVENT_SETTLE_MS = 250;

export interface FeedAwarePollOptions {
  readonly read: () => void;
  /** The cadence with no live feed: what this read polled at before it had one. */
  readonly everyMs: number;
  /** The safety-net cadence while the feed is live. */
  readonly liveEveryMs: number;
  /** Which feed events may have moved this read's answer; absent, no event reads. */
  readonly relevant?: (event: FyEvent) => boolean;
  readonly feed?: LiveFeedSignal;
  readonly environment?: FeedAwarePollEnvironment;
  readonly settleMs?: number;
}

/** Starts reading as described above; the returned function stops every timer and subscription. */
export const startFeedAwarePoll = (options: FeedAwarePollOptions): (() => void) => {
  const environment = options.environment ?? browserFeedAwarePollEnvironment;
  const { feed, read } = options;
  let timer: unknown;
  let settle: unknown;
  /** A read was due while the tab was hidden, so one is owed when it is shown. */
  let owed = false;
  let stopped = false;

  const cadence = (): number => (feed?.isLive?.() === true ? options.liveEveryMs : options.everyMs);
  const arm = (): void => {
    if (timer !== undefined) environment.clearTimeout(timer);
    timer = environment.setTimeout(tick, cadence());
  };
  const readNow = (): void => {
    if (environment.hidden()) {
      owed = true;
      return;
    }
    read();
    arm();
  };
  function tick(): void {
    timer = undefined;
    readNow();
  }

  const stops: (() => void)[] = [
    environment.onVisible(() => {
      if (!owed || stopped) return;
      owed = false;
      read();
      arm();
    }),
  ];
  const relevant = options.relevant;
  if (feed !== undefined && relevant !== undefined)
    stops.push(
      feed.subscribe(event => {
        if (stopped || settle !== undefined || !relevant(event)) return;
        settle = environment.setTimeout(() => {
          settle = undefined;
          readNow();
        }, options.settleMs ?? FEED_EVENT_SETTLE_MS);
      }),
    );
  const subscribeLive = feed?.subscribeLive;
  if (subscribeLive !== undefined)
    stops.push(
      subscribeLive(() => {
        if (!stopped && timer !== undefined) arm();
      }),
    );

  readNow();
  return () => {
    stopped = true;
    if (timer !== undefined) environment.clearTimeout(timer);
    if (settle !== undefined) environment.clearTimeout(settle);
    for (const stop of stops) stop();
  };
};

/** A plain poll that reads nothing while the tab is hidden: {@link startFeedAwarePoll} with no feed. */
export const startVisiblePoll = (
  read: () => void,
  everyMs: number,
  environment?: FeedAwarePollEnvironment,
): (() => void) =>
  startFeedAwarePoll({ read, everyMs, liveEveryMs: everyMs, ...(environment === undefined ? {} : { environment }) });

/** `read`, made to do nothing while the tab is hidden: for a plain interval whose skipped tick is not owed. */
export const whileVisible =
  (read: () => void, environment: Pick<FeedAwarePollEnvironment, 'hidden'> = browserFeedAwarePollEnvironment) =>
  (): void => {
    if (!environment.hidden()) read();
  };
