/**
 * A POLL THAT STANDS BACK WHILE THE DAEMON IS TELLING US WHAT CHANGED (copied from today's `lib/feed-aware-poll.ts`).
 *
 * A screen holds one live subscription to the daemon's event feed, and the feed already says when something it
 * shows moved. A list read every ten seconds beside it re-asks a question the feed has just answered — measured on
 * an idle session page over the relay, those re-reads were most of its traffic. So a read built on this:
 *
 *   * reads at once, and again soon after any feed event that may have moved its answer (a burst of events is one
 *     read, after `settleMs`);
 *   * while the feed is LIVE, polls only as a slow safety net (`liveEveryMs`), for what the feed does not say — a
 *     page the person closed elsewhere;
 *   * while there is no feed, or it is not live, polls at its old cadence (`everyMs`), so a dropped feed makes the
 *     screen as fresh as it always was rather than stale;
 *   * never reads while the tab is hidden: the tick is noted, and one read is made when it is shown;
 *   * never starts a read while its previous one is still in flight (when `read` returns its promise): a timer tick
 *     is skipped, and a feed event asks for ONE read once the pending one settles. A read the shell parks — a
 *     background read on a locked machine waits for its unlock prompt — therefore never piles up behind itself, and
 *     a confirm never releases a burst of them.
 *
 * A change of liveness re-arms the timer at the new cadence; it does not read by itself, because a feed that comes
 * back resumes and replays what it missed, and those events read.
 */

/** The event feed as a poller sees it: its events and, where the host knows it, whether it is live. */
export interface LiveFeedSignal<Event = unknown> {
  readonly subscribe: (listener: (event: Event) => void) => () => void;
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

export interface FeedAwarePollOptions<Event = unknown> {
  /** One read. Return its promise so a tick is skipped while it is still in flight; `void` keeps no such guard. */
  readonly read: () => unknown;
  /** The cadence with no live feed: what this read polled at before it had one. */
  readonly everyMs: number;
  /** The safety-net cadence while the feed is live. */
  readonly liveEveryMs: number;
  /** Which feed events may have moved this read's answer; absent, no event reads. */
  readonly relevant?: (event: Event) => boolean;
  readonly feed?: LiveFeedSignal<Event>;
  readonly environment?: FeedAwarePollEnvironment;
  readonly settleMs?: number;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Starts reading as described above; the returned function stops every timer and subscription.
 *
 * GAP(app-shell): `read()` takes no abort signal, so a read parked behind a passkey prompt is not released when the poll
 * stops (today's `shared-reads` abort chain did). See `packages/app/README.md` › Open items.
 */
export const startFeedAwarePoll = <Event = unknown>(options: FeedAwarePollOptions<Event>): (() => void) => {
  const environment = options.environment ?? browserFeedAwarePollEnvironment;
  const { feed, read } = options;
  let timer: unknown;
  let settle: unknown;
  /** A read was due while the tab was hidden, so one is owed when it is shown. */
  let owed = false;
  let stopped = false;
  /** A read is in flight (its promise has not settled). */
  let inFlight = false;
  /** A feed event asked for a read while one was in flight: one more is made when it settles. */
  let trailing = false;

  /** Starts one read, unless one is in flight; `event` reads are kept as one trailing read instead of dropped. */
  const start = (event: boolean): void => {
    if (inFlight) {
      if (event) trailing = true;
      return;
    }
    let returned: unknown;
    try {
      returned = read();
    } catch {
      return;
    }
    if (!isThenable(returned)) return;
    const pending = returned;
    inFlight = true;
    const settled = (): void => {
      inFlight = false;
      if (!trailing || stopped) return;
      trailing = false;
      readNow(true);
    };
    pending.then(settled, settled);
  };

  const cadence = (): number => (feed?.isLive?.() === true ? options.liveEveryMs : options.everyMs);
  const arm = (): void => {
    if (timer !== undefined) environment.clearTimeout(timer);
    timer = environment.setTimeout(tick, cadence());
  };
  function readNow(event = false): void {
    if (environment.hidden()) {
      owed = true;
      return;
    }
    start(event);
    arm();
  }
  function tick(): void {
    timer = undefined;
    readNow();
  }

  const stops: (() => void)[] = [
    environment.onVisible(() => {
      if (!owed || stopped) return;
      owed = false;
      start(false);
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
          readNow(true);
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
  read: () => unknown,
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
