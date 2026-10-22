/**
 * WHEN TO READ A MACHINE'S SESSION LIST AGAIN, SAID BY THE MACHINE.
 *
 * The all-machines list used to learn about a session's turn ending by asking every thirty seconds.
 * The daemon journals every change a list row shows — a turn starting and ending, a send landing, a
 * session created, renamed or stopped — and serves the whole fleet's journal as one live feed
 * (`/v1/events` with no session). With `tail=0` the feed replays nothing, so opening it costs a socket
 * and nothing else, and the daemon proves it live with an idle frame the moment it opens.
 *
 * So this holds one fleet feed per machine and says WHEN to re-read: once after a burst of events has
 * settled, at most every {@link FLEET_FEED_MIN_INTERVAL_MS}. The read itself is the list the poll always
 * made, which the daemon answers `304` when nothing moved. While the feed is live, the poll beside it
 * becomes a slow safety net (`use-machines-poll.ts`).
 *
 * A DAEMON FROM BEFORE `tail` refuses the feed outright (400, before any frame). That is not an
 * outage to retry: the machine is marked `unsupported` for this document and the list is polled as it
 * always was. Any other end — a dropped carrier, a daemon restart, a feed that went silent — is retried
 * on the session feed's own jittered schedule, and a feed that comes back says so with one read,
 * because a feed with no replay cannot say what changed while it was away.
 */

import type { FyEvent } from '@ferretry/protocol';
import { sessionEventStreamDeadlineMs, sessionEventStreamDelayMs } from '../components/session-event-stream-model.ts';

/** How long a burst of events is let settle before the one read it asks for. */
export const FLEET_FEED_SETTLE_MS = 500;
/** The shortest gap between two reads a feed asks for, however busy the fleet. */
export const FLEET_FEED_MIN_INTERVAL_MS = 2_000;

/** What the poll beside a feed is told: whether it may stand back. */
export type FleetFeedStatus = 'connecting' | 'live' | 'down' | 'unsupported';

/** Timers and a jitter source, injectable so a suite drives the feed by hand. */
export interface FleetFeedEnvironment {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
  readonly random: () => number;
}

export const browserFleetFeedEnvironment: FleetFeedEnvironment = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
};

/** Opens one fleet feed: resolves or rejects when it ends; `onIdle` is the daemon's proof it is alive. */
export type OpenFleetFeed = (
  onEvent: (event: FyEvent) => void,
  onIdle: (idleSeconds: number) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface FleetFeedOptions {
  readonly open: OpenFleetFeed;
  /** The list may have moved: read it again. */
  readonly onChange: () => void;
  readonly onStatus?: (status: FleetFeedStatus) => void;
  readonly environment?: FleetFeedEnvironment;
}

export interface FleetFeedControl {
  readonly status: () => FleetFeedStatus;
  readonly stop: () => void;
}

/** A daemon that does not know `tail` refuses the upgrade with 400; nothing else says "too old". */
const refusedAsTooOld = (reason: unknown): boolean => (reason as { readonly status?: unknown } | null)?.status === 400;

/** A surface's control facts move nothing on a list row. */
const movesTheList = (event: FyEvent): boolean => !event.type.startsWith('surface.');

export const startFleetFeed = (options: FleetFeedOptions): FleetFeedControl => {
  const environment = options.environment ?? browserFleetFeedEnvironment;
  let status: FleetFeedStatus = 'connecting';
  let stopped = false;
  let attempt = 0;
  let wasLive = false;
  let abort: AbortController | undefined;
  let retry: unknown;
  let silence: unknown;
  let settle: unknown;
  let lastChangeAt = Number.NEGATIVE_INFINITY;

  const publish = (next: FleetFeedStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };
  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) environment.clearTimeout(handle);
    return undefined;
  };

  const change = (): void => {
    if (settle !== undefined) return;
    const wait = Math.max(FLEET_FEED_SETTLE_MS, lastChangeAt + FLEET_FEED_MIN_INTERVAL_MS - environment.now());
    settle = environment.setTimeout(() => {
      settle = undefined;
      if (stopped) return;
      lastChangeAt = environment.now();
      options.onChange();
    }, wait);
  };

  function open(): void {
    const controller = new AbortController();
    abort = controller;
    let proved = false;
    let ended = false;
    const current = (): boolean => !stopped && abort === controller && !ended;
    const watch = (idleSeconds: number | undefined): void => {
      silence = clear(silence);
      silence = environment.setTimeout(() => {
        silence = undefined;
        if (current()) controller.abort();
      }, sessionEventStreamDeadlineMs(idleSeconds));
    };
    const alive = (idleSeconds: number | undefined): void => {
      if (!current()) return;
      watch(idleSeconds);
      if (proved) return;
      proved = true;
      attempt = 0;
      // A feed with no replay cannot say what changed while it was gone, so coming back is one read.
      if (wasLive) change();
      wasLive = true;
      publish('live');
    };
    const end = (reason: unknown): void => {
      if (ended || stopped || abort !== controller) return;
      ended = true;
      silence = clear(silence);
      if (!proved && refusedAsTooOld(reason)) {
        publish('unsupported');
        return;
      }
      publish('down');
      const delay = sessionEventStreamDelayMs(attempt, environment.random());
      attempt += 1;
      retry = environment.setTimeout(() => {
        retry = undefined;
        if (!stopped) open();
      }, delay);
    };
    watch(undefined);
    options
      .open(
        event => {
          alive(undefined);
          if (current() && movesTheList(event)) change();
        },
        idleSeconds => alive(idleSeconds),
        controller.signal,
      )
      .then(
        () => end(undefined),
        reason => end(reason),
      );
  }

  open();
  return {
    status: () => status,
    stop: () => {
      stopped = true;
      retry = clear(retry);
      silence = clear(silence);
      settle = clear(settle);
      abort?.abort();
    },
  };
};
