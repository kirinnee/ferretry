import type { FyEvent, IFyApiClient, SessionLiveActivity, SessionTranscriptMoved } from '@ferretry/protocol';

/**
 * What a reader is allowed to be told about the live feed, and nothing finer.
 *
 * `connecting` is NOT `live`, and that distinction is the whole point of this union. The transport
 * has no open callback — `IFyApiClient.stream` resolves when the feed ENDS and rejects when it ends
 * badly, and says nothing in between — so "a socket was constructed" is not evidence the daemon is
 * on the other end of it. The only evidence that exists is a frame arriving, of either kind, which
 * is why the daemon's recurring idle proof and this union were designed together: without recurring
 * traffic a quiet session could never leave `connecting`.
 */
export type SessionEventStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

/**
 * The retry schedule, as the four numbers that generate it rather than a table.
 *
 * THE DELAY IS BOUNDED AND THE ATTEMPTS ARE NOT. This schedule used to stop after eight attempts, on
 * the argument that a page left open overnight against a machine that is off should stop asking. In
 * practice the outage that ended feeds was never a machine that was off: it was a relay redeployed
 * under a live page, or a phone that slept through a minute, and a feed that had given up by the time
 * the carrier came back stayed dead until the reader found a button. The cost of asking forever is
 * bounded by the ceiling — one attempt per ten seconds at worst — and the connection model's recovery
 * signal (`onRecovered`) reopens the feed the moment ANY request reaches the daemon again, so a
 * returning carrier is noticed in one round trip rather than one backoff window.
 *
 * `disconnected` is still a state — a host that passes a finite `attemptBudget` reaches it — but the
 * shipped app does not, because "it stopped trying" is not something a reader should have to repair.
 */
export const SESSION_EVENT_STREAM_BACKOFF = {
  /**
   * The first window: a retry inside 150–300 ms, so a socket blip is back long before the chip's quiet
   * window ({@link SESSION_EVENT_STREAM_QUIET_MS}) would say anything. It doubles from there.
   */
  baseMs: 300,
  factor: 2,
  /** No window is ever longer than this, jitter included — see {@link sessionEventStreamDelayMs}. */
  ceilingMs: 10_000,
  /** Automatic attempts before the schedule settles into `disconnected`: none, it never does. */
  attemptBudget: Number.POSITIVE_INFINITY,
} as const;

/**
 * The delay before retry number `attempt`, jittered.
 *
 * EQUAL JITTER, so the range is provable in both directions: the window doubles to a ceiling, and
 * the delay lands somewhere in the upper half of it — never below `window / 2`, never above
 * `window`, and therefore never above {@link SESSION_EVENT_STREAM_BACKOFF.ceilingMs}. Full jitter
 * (anywhere in `[0, window]`) would have let a long backoff collapse back to nearly zero and start
 * hammering a daemon that is still down; no jitter at all would have every tab a reader left open
 * retry the returning daemon in the same millisecond.
 *
 * `random` is clamped rather than trusted. It is injected so a test can prove the two ends of the
 * range exactly, and an injected value is the one input here that no type can bound.
 *
 * A CLAMP IS NOT A CLAMP UNTIL IT CONTAINS `NaN`. `Math.min`/`Math.max` PROPAGATE it rather than
 * bounding it, so a `NaN` draw came out of a "clamped" expression as `NaN`, and a browser timer
 * coerces that to zero — a retry storm at the exact input this function's own doc calls untrusted,
 * and below the lower bound its own test claims cannot be escaped. So non-finite inputs are
 * normalised BEFORE the clamp rather than being assumed away: an unusable draw becomes the bottom of
 * the range, which is the same answer a caller gets from `random() === 0` and never a shorter wait
 * than the schedule allows. `attempt` gets the same treatment for the same reason — this helper is
 * exported, so its totality is part of its contract and not an internal detail.
 */
export const sessionEventStreamDelayMs = (attempt: number, random: number): number => {
  const { baseMs, factor, ceilingMs } = SESSION_EVENT_STREAM_BACKOFF;
  const step = Number.isFinite(attempt) ? Math.max(0, attempt) : 0;
  const windowMs = Math.min(ceilingMs, baseMs * factor ** step);
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.round(windowMs / 2 + (windowMs / 2) * jitter);
};

/**
 * How long a subscription may hear NOTHING before this end decides the path is gone.
 *
 * A CLOSE IS NOT GUARANTEED, WHICH IS WHY THIS EXISTS. Everything else in this model reacts to the
 * transport ending — resolve on a clean close, reject on an unexpected one — and a path that is
 * blackholed rather than reset never ends at all. A phone that walks out of Wi-Fi range, a NAT table
 * that forgot the mapping, a proxy that dropped the connection without telling either side: the
 * socket object survives, no close arrives, and the promise this model is awaiting stays pending
 * forever. Recurring server traffic is what makes that path OBSERVABLE — but only to an end that is
 * watching for its absence, which is this timer. The two halves of the fix are useless apart.
 *
 * THE CADENCE IS READ OFF THE WIRE, NOT AGREED IN ADVANCE. The daemon states its own idle period in
 * every proof it sends (`idleSeconds`), so this end derives the deadline from what the daemon
 * actually said rather than from a second copy of a number the daemon owns — a copy that would rot
 * silently the day somebody tuned the daemon's window.
 *
 * AND IT IS CLAMPED AT BOTH ENDS BEFORE IT BECOMES A TIMEOUT, because `idleSeconds` is a positive
 * integer on the wire and nothing narrower. A declared window is a REMOTE NUMBER: the daemon a
 * browser is talking to may be older, newer, misconfigured, or — over a rendezvous — not the daemon
 * anybody meant. Below {@link minWindowMs} it would make this end trigger-happy, reconnecting over
 * ordinary jitter. Above {@link maxWindowMs} it would do something worse and quieter: one frame
 * declaring `idleSeconds: 86400` would push the deadline out past any session anybody will ever have
 * open, which does not merely weaken the watchdog — it DELETES it, and leaves exactly the silent
 * permanent stall this whole model exists to end. So the clamp is the security-relevant half of the
 * derivation, not a tidiness one, and the range is stated here rather than inferred at the call.
 */
export const SESSION_EVENT_STREAM_SILENCE = {
  /** Missed windows tolerated. One is a dropped frame; three in a row is not a coincidence. */
  missedWindows: 3,
  /** Used until the daemon has declared anything, and the floor for what it may declare. */
  minWindowMs: 30_000,
  /** The longest window this end will honour, whatever a daemon claims. */
  maxWindowMs: 120_000,
} as const;

/** The silence budget, given whatever cadence the daemon has declared so far (`undefined` = none yet). */
export const sessionEventStreamDeadlineMs = (declaredIdleSeconds: number | undefined): number => {
  const { missedWindows, minWindowMs, maxWindowMs } = SESSION_EVENT_STREAM_SILENCE;
  const declaredMs = (declaredIdleSeconds ?? 0) * 1_000;
  // `Number.isFinite` because a NaN or an Infinity survives both comparisons of a bare clamp and
  // comes out the other side as the deadline itself, which is the same deleted watchdog by another
  // route. An unusable claim falls back to the floor rather than to whatever it said.
  const honoured = Number.isFinite(declaredMs) ? Math.min(maxWindowMs, Math.max(minWindowMs, declaredMs)) : minWindowMs;
  return missedWindows * honoured;
};

/**
 * How long a lost feed stays UNSAID. Most drops are a relay socket that is back within a round trip or
 * two, and the chip saying "Reconnecting" for each of them read as an app that was always
 * reconnecting. The model still knows at once — its recovery hook and `status()` read the truth — and
 * only the published report waits: a feed that is `live` again within this window never said it left.
 */
export const SESSION_EVENT_STREAM_QUIET_MS = 2_000;

/** A daemon that does not know a query flag refuses the upgrade with 400; nothing else says "too old". */
const refusedAsUnknown = (reason: unknown): boolean => (reason as { readonly status?: unknown } | null)?.status === 400;

export interface SessionEventStreamEnvironment {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** `Math.random` in the browser; a fixed sequence in a test, which is what makes jitter provable. */
  readonly random: () => number;
}

export interface SessionEventStreamInput {
  readonly api: Pick<IFyApiClient, 'stream'>;
  readonly sessionId: string;
  /** The sequence already seen elsewhere. Every reconnection resumes from the highest one delivered. */
  readonly after?: number;
  readonly environment: SessionEventStreamEnvironment;
  readonly onEvent: (event: FyEvent) => void;
  /**
   * Asks the daemon for the working turn's live readout (`?live=1`) and receives each sample. A
   * sample is traffic like any frame — it proves the feed is live — but it is never an event: it
   * advances no cursor and triggers no re-read.
   */
  readonly onLive?: (live: SessionLiveActivity) => void;
  /**
   * Asks the daemon to say when the session's transcript changes (`?transcript=1`) and is called each
   * time it does — the one signal that a reply's text or a tool call landed, which no journal event says.
   * Like a live sample it proves the feed and advances no cursor.
   *
   * A DAEMON THAT PREDATES THE FLAG refuses the upgrade with 400 before any frame. That is not an outage:
   * the feed reopens at once without the flag, spends nothing from the retry budget, and does not ask
   * again for this page view — the transcript then moves on events and the poll, as before.
   */
  readonly onTranscript?: (moved: SessionTranscriptMoved) => void;
  /** Called on every CHANGE of state, never on a repeat, so a host can hand it straight to `setState`. */
  readonly onStatus?: (status: SessionEventStreamStatus) => void;
  /** Overridable only so a test can exhaust the schedule; production uses the shipped budget. */
  readonly attemptBudget?: number;
  /**
   * Subscribes to "the daemon is reachable again" (the connection model's `onRecovered`, bound to this
   * daemon); returns how to stop. A feed waiting out a backoff when it fires reconnects AT ONCE, from its
   * cursor, rather than waiting out its backoff. Injected rather than imported, so this model needs no
   * store.
   */
  readonly onRecovered?: (listener: () => void) => () => void;
}

export interface SessionEventStreamControl {
  /** Cancels the open socket AND any scheduled reconnection. Safe to call more than once. */
  readonly stop: () => void;
  /**
   * Start over now: abandon whatever is open or scheduled, restore the full budget, and reconnect.
   *
   * This is the reader's way back from `disconnected`, and it is also correct from `reconnecting` —
   * somebody who can see the daemon is back should not have to wait out a backoff window.
   */
  readonly reconnect: () => void;
  readonly status: () => SessionEventStreamStatus;
}

/**
 * Keeps one session subscribed to the daemon's live feed across the whole life of a page view.
 *
 * WHY THIS IS A MODEL AND NOT AN EFFECT. The subscription used to be a single `client.stream(…)`
 * inside a React effect whose rejection was swallowed and whose dependencies were a client, a
 * carrier object and a session id — none of which change when a socket dies. So the first network
 * hiccup, sleep/wake, Wi-Fi roam or daemon restart ended live push for that page view permanently,
 * and the only cures were navigation or a reload. The three-second poll underneath keeps the
 * transcript CORRECT, which is why this was never visible as a failure; it is what made a
 * permanently degraded feed look like a working one. A retry written inside that effect would have
 * been a timer no test could drive, so the schedule lives here, against an injected clock.
 *
 * A RESOLVED STREAM IS A RETRY TOO. The transport resolves on a clean close and rejects on an
 * unexpected one, and both mean the same thing to a reader: the feed stopped. Only {@link
 * SessionEventStreamControl.stop} — this owner deciding — ends the loop for good.
 *
 * AND SO IS A SILENCE. Reacting only to a close would have fixed nothing on the failure that
 * actually strands a browser, because that failure never produces one — see {@link
 * SESSION_EVENT_STREAM_SILENCE}. A subscription that hears nothing for three of the daemon's own
 * idle windows is cancelled from this end and treated exactly like a close.
 *
 * THE CURSOR ONLY MOVES FORWARD, and a reconnection resumes from it rather than from zero: asking
 * again from the start would replay the entire tail into the transcript on every flap.
 *
 * THE BUDGET IS RESET BY EVIDENCE, NOT BY AN OPEN. There is no open callback to reset on, and
 * treating construction as success would let a socket that fails immediately, every time, cycle
 * forever at the first delay. So a delivered frame of EITHER kind is what counts as a working path:
 * an event proves it end to end, and the daemon's recurring idle proof is what a quiet session has
 * instead. A stream that connects, sits quiet for an hour and then flaps must not resume at the
 * backoff it reached an hour ago, and recurring idle traffic is what makes that true.
 *
 * A STALE CALLBACK CANNOT TOUCH THE REPLACEMENT, and "stale" is two different things. A cancelled
 * transport is not obliged to fall silent the instant its signal aborts — a relayed session in
 * particular settles across the network — so an attempt is only current while it is BOTH the newest
 * one and unfinished. Those come apart: being replaced advances the generation, but simply ENDING
 * does not, because during a backoff window the replacement has not been opened yet. A late event
 * from either kind of dead attempt must not advance the cursor, refresh the host, reset the budget,
 * arm a deadline, publish `live` or schedule a retry beside the pending one, and asking both
 * questions is what makes each of those impossible rather than unlikely.
 */
export const startSessionEventStream = (input: SessionEventStreamInput): SessionEventStreamControl => {
  const budget = input.attemptBudget ?? SESSION_EVENT_STREAM_BACKOFF.attemptBudget;
  const environment = input.environment;
  let generation = 0;
  let stopped = false;
  let attempt = 0;
  let cursor = input.after ?? 0;
  let timer: unknown;
  let silence: unknown;
  let abort: AbortController | undefined;
  let status: SessionEventStreamStatus = 'connecting';
  /** What the host was last told, which trails `status` only while a drop is inside its quiet window. */
  let reported: SessionEventStreamStatus = 'connecting';
  let quiet: unknown;
  /** The daemon's own declared idle period, learned from the first proof and kept across attempts. */
  let declaredIdleSeconds: number | undefined;
  /** The daemon refused `?transcript=1` as unknown: it is older than the signal, so this view stops asking. */
  let transcriptRefused = false;

  const report = (next: SessionEventStreamStatus): void => {
    if (quiet !== undefined) environment.clearTimeout(quiet);
    quiet = undefined;
    if (reported === next) return;
    reported = next;
    input.onStatus?.(next);
  };

  /**
   * A drop from `live` is reported only once it has outlasted {@link SESSION_EVENT_STREAM_QUIET_MS};
   * every other change is reported at once, and any later change cancels a report still waiting.
   */
  const publish = (next: SessionEventStreamStatus): void => {
    if (status === next) return;
    const from = status;
    status = next;
    if (next === 'reconnecting' && from === 'live' && reported === 'live') {
      if (quiet !== undefined) environment.clearTimeout(quiet);
      quiet = environment.setTimeout(() => {
        quiet = undefined;
        if (!stopped) report(status);
      }, SESSION_EVENT_STREAM_QUIET_MS);
      return;
    }
    if (quiet !== undefined && next === 'connecting') return;
    report(next);
  };

  const clearSilence = (): void => {
    if (silence !== undefined) environment.clearTimeout(silence);
    silence = undefined;
  };

  /** Abandons the current attempt and everything scheduled for it, without deciding what comes next. */
  const abandon = (): void => {
    generation += 1;
    abort?.abort();
    abort = undefined;
    if (timer !== undefined) environment.clearTimeout(timer);
    timer = undefined;
    clearSilence();
  };

  /**
   * Accept a frame as evidence, but only from the attempt that is still the live one.
   *
   * `current` is the attempt's own predicate rather than a generation number, because a generation
   * is not enough on its own: an attempt that has ENDED keeps the newest generation until its retry
   * timer opens the replacement, and a late frame arriving inside that gap would otherwise pass. See
   * {@link SessionEventStreamControl} — the two ways an attempt stops being current are different
   * facts and both have to be asked about.
   */
  const proved = (current: () => boolean): boolean => {
    if (!current()) return false;
    attempt = 0;
    publish('live');
    return true;
  };

  const ended = (mine: number): void => {
    if (stopped || mine !== generation) return;
    abort = undefined;
    clearSilence();
    if (attempt >= budget) {
      // Honest, and terminal until the reader says otherwise: nothing here will try again.
      publish('disconnected');
      return;
    }
    const delay = sessionEventStreamDelayMs(attempt, environment.random());
    attempt += 1;
    publish('reconnecting');
    timer = environment.setTimeout(() => {
      timer = undefined;
      if (stopped || mine !== generation) return;
      open();
    }, delay);
  };

  function open(): void {
    generation += 1;
    const mine = generation;
    const controller = new AbortController();
    abort = controller;
    // ONE END PER ATTEMPT. The watchdog below and the transport's own settlement are two independent
    // ways for the same attempt to finish, and they can both happen: cancelling a blackholed socket
    // is exactly what finally makes its promise settle. Without this, one dead attempt would schedule
    // two reconnections and the browser would end up holding two live streams for one session.
    let finished = false;
    /**
     * Whether this attempt is still the one whose frames count, which is TWO facts and not one.
     *
     * A generation alone says whether something REPLACED this attempt. It says nothing about whether
     * this attempt already ended, and those come apart for the whole length of a backoff window: a
     * settlement schedules a retry WITHOUT advancing the generation, because the replacement does not
     * exist yet. A frame arriving from the settled transport in that gap therefore still carried the
     * newest generation, and would have been accepted as proof — publishing `live` over a feed that
     * had stopped, restoring the full retry budget, moving the cursor and arming a deadline for a
     * socket nobody held, all while the scheduled reconnection was still pending. That is the same
     * "a dead stream looks alive" defect this model exists to end, reintroduced one layer in.
     */
    const currentAttempt = (): boolean => !stopped && mine === generation && !finished;
    /** Whether this attempt has delivered any frame: a refusal only ever comes before the first. */
    let heard = false;
    const asksTranscript = input.onTranscript !== undefined && !transcriptRefused;
    const finish = (): void => {
      if (!currentAttempt()) return;
      finished = true;
      ended(mine);
    };
    const failed = (reason: unknown): void => {
      if (asksTranscript && !heard && refusedAsUnknown(reason) && currentAttempt()) {
        // An older daemon, not a broken path: open again at once, without the flag and without a retry.
        transcriptRefused = true;
        finished = true;
        abort = undefined;
        clearSilence();
        open();
        return;
      }
      finish();
    };
    const fresh = (): boolean => {
      if (!proved(currentAttempt)) return false;
      heard = true;
      return true;
    };
    const watch = (): void => {
      clearSilence();
      silence = environment.setTimeout(() => {
        silence = undefined;
        if (!currentAttempt()) return;
        // Nothing at all for three of the daemon's own windows. Cancelling is what turns a socket
        // that will never close into an attempt that has ended, which is the only shape the retry
        // schedule below knows how to act on.
        controller.abort();
        finish();
      }, sessionEventStreamDeadlineMs(declaredIdleSeconds));
    };
    watch();
    void input.api
      .stream(
        input.sessionId,
        cursor,
        event => {
          if (!fresh()) return;
          watch();
          cursor = Math.max(cursor, event.sequence);
          input.onEvent(event);
        },
        controller.signal,
        idle => {
          if (!fresh()) return;
          declaredIdleSeconds = idle.idleSeconds;
          watch();
        },
        input.onLive === undefined
          ? undefined
          : live => {
              if (!fresh()) return;
              watch();
              input.onLive?.(live);
            },
        asksTranscript
          ? moved => {
              if (!fresh()) return;
              watch();
              input.onTranscript?.(moved);
            }
          : undefined,
      )
      .then(finish, failed);
  }

  const reconnect = (): void => {
    if (stopped) return;
    abandon();
    attempt = 0;
    publish('connecting');
    open();
  };

  open();
  // ONLY A FEED THAT IS WAITING. `connecting` has an attempt in flight — opened by this very recovery,
  // often — and reopening it would hold two sockets for one session; `live` needs nothing.
  const stopRecovered = input.onRecovered?.(() => {
    if (status === 'reconnecting' || status === 'disconnected') reconnect();
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopRecovered?.();
      if (quiet !== undefined) environment.clearTimeout(quiet);
      quiet = undefined;
      // Both halves, because a loop is only ever in one of them: the transport is cancelled through
      // the signal it was handed, and a scheduled reconnection is cancelled before it can fire.
      // Nothing is published — the owner tearing this down is not news anyone is left to hear.
      abandon();
    },
    reconnect,
    status: () => status,
  };
};
