/**
 * WHEN TO READ A MACHINE'S SESSION LIST AGAIN, SAID BY THE MACHINE.
 *
 * The all-machines list used to learn about a session's turn ending by asking every thirty seconds.
 * The daemon journals every change a list row shows — a turn starting and ending, a send landing, a
 * session created, renamed or stopped — and serves the whole fleet's journal as one live feed
 * (`/v1/events` with no session). With `tail=0` the feed replays nothing, so opening it costs a socket
 * and nothing else, and the daemon proves it live with an idle frame the moment it opens.
 *
 * So this holds one fleet feed per machine and immediately invalidates the shared list source.
 * That source owns the single coalescing budget across every reader. The read itself is the list
 * the poll always made, which the daemon answers `304` when nothing moved. While the feed is live, the poll beside it
 * becomes a slow safety net (`use-machines-poll.ts`).
 *
 * A DAEMON FROM BEFORE `tail` refuses the feed outright (400, before any frame). That is not an
 * outage to retry: the machine is marked `unsupported` for this document and the list is polled as it
 * always was. Any other end — a dropped carrier, a daemon restart, a feed that went silent — is retried
 * on the session feed's own jittered schedule, and a feed that comes back says so with one read,
 * because a feed with no replay cannot say what changed while it was away.
 */

import { type FyEvent, SURFACE_EVENT_TYPES } from '../../contract/index.ts';
import { isMachineAgendaId, QUEUE_CHANGED_EVENT } from '@ferretry/protocol';
import { sessionEventStreamDeadlineMs, sessionEventStreamDelayMs } from '../components/session-event-stream-model.ts';

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
  /** Every event the feed delivers, as it arrives; for readers that need the payload, not just "something moved". */
  readonly onEvent?: (event: FyEvent) => void;
  /** One reconciliation after the stream returns, also for lists other than the fleet. */
  readonly onReconnect?: () => void;
  readonly onStatus?: (status: FleetFeedStatus) => void;
  readonly environment?: FleetFeedEnvironment;
}

export interface FleetFeedControl {
  readonly status: () => FleetFeedStatus;
  readonly stop: () => void;
}

/** A daemon that does not know `tail` refuses the upgrade with 400; nothing else says "too old". */
const refusedAsTooOld = (reason: unknown): boolean => (reason as { readonly status?: unknown } | null)?.status === 400;

/**
 * SurfaceControl changes only surface maps and journals them, never session config/state or agendas. A durable queue
 * change (`control.queue_changed`, ids only) changes only that session's queue, which no list row shows — it is
 * announced so the open chat reads `GET …/queue` (the per-session feed nudges on every event), and re-reading every
 * session of the machine after each queued message would cost a list download for nothing.
 */
const LIST_NEUTRAL_EVENTS = new Set<string>([...Object.values(SURFACE_EVENT_TYPES), QUEUE_CHANGED_EVENT]);

// Lifecycle, observer, send, resume and signal transitions (including interaction.help) all
// change row facts. Agenda summaries are changed by agenda.changed / attention.changed;
// the machine agenda belongs only to the agenda source. Board writes can update a session's
// focusTask and auto-title (StorageSessionFocus), so board.changed also invalidates the list.
// Default to reading new event types.
const movesTheList = (event: FyEvent): boolean =>
  !LIST_NEUTRAL_EVENTS.has(event.type) &&
  !(isMachineAgendaId(event.sessionId) && (event.type === 'agenda.changed' || event.type === 'attention.changed'));

export const startFleetFeed = (options: FleetFeedOptions): FleetFeedControl => {
  const environment = options.environment ?? browserFleetFeedEnvironment;
  let status: FleetFeedStatus = 'connecting';
  let stopped = false;
  let attempt = 0;
  let wasLive = false;
  let recovering = false;
  let abort: AbortController | undefined;
  let retry: unknown;
  let silence: unknown;

  const publish = (next: FleetFeedStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };
  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) environment.clearTimeout(handle);
    return undefined;
  };

  const change = (): void => options.onChange();

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
      if (wasLive || recovering) {
        change();
        options.onReconnect?.();
      }
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
      recovering = true;
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
          if (!current()) return;
          options.onEvent?.(event);
          if (movesTheList(event)) change();
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
      abort?.abort();
    },
  };
};
