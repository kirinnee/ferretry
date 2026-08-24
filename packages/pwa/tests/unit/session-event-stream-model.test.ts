import { describe, expect, test } from 'bun:test';
import type { FyEvent, FyEventStreamIdle } from '@ferretry/protocol';
import {
  SESSION_EVENT_STREAM_BACKOFF,
  SESSION_EVENT_STREAM_SILENCE,
  type SessionEventStreamEnvironment,
  type SessionEventStreamInput,
  type SessionEventStreamStatus,
  sessionEventStreamDeadlineMs,
  sessionEventStreamDelayMs,
  startSessionEventStream,
} from '../../src/components/session-event-stream-model.ts';

/**
 * The live feed's reconnect model, driven entirely against injected clocks.
 *
 * WHAT THIS SUITE HAS TO GET RIGHT. The defect it exists for was invisible in production for the
 * life of the feature — a stream that died once and never came back, hidden behind a poll that kept
 * the transcript correct — so every failure mode here is one that looks like success from outside:
 *
 * - a stream that ends and schedules nothing is indistinguishable from a stream that is merely quiet;
 * - a stream that never ends because the path was blackholed is indistinguishable from BOTH;
 * - a retry schedule with no jitter and no bound looks identical to a good one until a daemon is
 *   actually down and every open tab is hammering it in lockstep;
 * - a stale callback from an abandoned socket corrupts the replacement silently, and the corruption
 *   is a cursor that skipped — which surfaces as missing transcript, nowhere near this file.
 *
 * So the fake transport hands the test the daemon's half of every subscription — `emit`, `idle`,
 * `end` and `fail` — and the fake clock never fires anything the test did not ask for. Nothing here
 * waits on a real timer, and nothing here trusts `Math.random`.
 */

interface Attempt {
  readonly sessionId: string | undefined;
  readonly after: number;
  readonly signal: AbortSignal | undefined;
  readonly emit: (event: FyEvent) => void;
  readonly idle: (idle: FyEventStreamIdle) => void;
  /** The daemon closed cleanly. The transport resolves. */
  readonly end: () => void;
  /** The socket died. The transport rejects. */
  readonly fail: () => void;
}

/** Every subscription the model opened, with the daemon's half of it still in the test's hands. */
class ScriptedStream {
  readonly attempts: Attempt[] = [];

  get last(): Attempt {
    const attempt = this.attempts.at(-1);
    if (attempt === undefined) throw new Error('no subscription has been opened');
    return attempt;
  }

  readonly stream = async (
    sessionId: string | undefined,
    after: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
  ): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      this.attempts.push({
        sessionId,
        after,
        signal,
        emit: onEvent,
        idle: frame => onIdle?.(frame),
        end: resolve,
        fail: () => reject(new Error('WebSocket stream closed unexpectedly: code 1006')),
      });
    });
}

interface Armed {
  readonly delay: number;
  readonly run: () => void;
}

/** A clock nothing advances by itself, so every delay is a decision the test makes. */
class ManualClock {
  readonly armed: Armed[] = [];
  /** The jitter sequence, consumed one draw per scheduled retry; the last value repeats. */
  draws: number[] = [0];
  private drawn = 0;

  readonly environment: SessionEventStreamEnvironment = {
    setTimeout: (callback, milliseconds) => {
      const handle = { delay: milliseconds, run: callback };
      this.armed.push(handle);
      return handle;
    },
    clearTimeout: handle => {
      const index = this.armed.indexOf(handle as Armed);
      if (index >= 0) this.armed.splice(index, 1);
    },
    random: () => {
      const value = this.draws[Math.min(this.drawn, this.draws.length - 1)] ?? 0;
      this.drawn += 1;
      return value;
    },
  };

  /** The delays of everything currently scheduled, longest-lived first-armed. */
  get delays(): number[] {
    return this.armed.map(handle => handle.delay);
  }

  /** Runs the one timer armed at `delay`, exactly as a real clock reaching it would. */
  fire(delay: number): void {
    const index = this.armed.findIndex(handle => handle.delay === delay);
    if (index < 0) throw new Error(`nothing is armed at ${delay}ms; armed: ${JSON.stringify(this.delays)}`);
    const [handle] = this.armed.splice(index, 1);
    handle?.run();
  }
}

const DEADLINE = sessionEventStreamDeadlineMs(undefined);

const event = (sequence: number): FyEvent => ({
  sequence,
  time: '2026-08-24T00:00:00.000Z',
  sessionId: 's1',
  type: 'session.turn',
  source: 'daemon',
  data: { sequence },
});

const idleFrame = (idleSeconds: number): FyEventStreamIdle => ({
  kind: 'idle',
  idleSeconds,
  scope: { kind: 'session', sessionId: 's1', after: 0 },
});

interface Harness {
  readonly transport: ScriptedStream;
  readonly clock: ManualClock;
  readonly events: FyEvent[];
  readonly statuses: SessionEventStreamStatus[];
  readonly control: ReturnType<typeof startSessionEventStream>;
}

const subject = (overrides: Partial<SessionEventStreamInput> = {}): Harness => {
  const transport = new ScriptedStream();
  const clock = new ManualClock();
  const events: FyEvent[] = [];
  const statuses: SessionEventStreamStatus[] = [];
  const control = startSessionEventStream({
    api: { stream: transport.stream },
    sessionId: 's1',
    environment: clock.environment,
    onEvent: value => events.push(value),
    onStatus: status => statuses.push(status),
    ...overrides,
  });
  return { transport, clock, events, statuses, control };
};

/** Ends the current attempt and lets the rejection/resolution reach the model. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('the live feed retry schedule', () => {
  test('doubles to a ceiling and never exceeds it, jitter included', () => {
    // Arrange — the two ends of the jitter range and the middle, at every attempt the budget allows.
    const attempts = Array.from({ length: SESSION_EVENT_STREAM_BACKOFF.attemptBudget }, (_, index) => index);

    // Act
    const floors = attempts.map(attempt => sessionEventStreamDelayMs(attempt, 0));
    const ceilings = attempts.map(attempt => sessionEventStreamDelayMs(attempt, 1));
    const middles = attempts.map(attempt => sessionEventStreamDelayMs(attempt, 0.5));

    // Assert — equal jitter: each delay lands in the UPPER HALF of its window, so the schedule can
    // neither collapse back to hammering a daemon that is still down nor run past the ceiling.
    expect(floors).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    for (const [index, middle] of middles.entries()) {
      expect(middle).toBeGreaterThanOrEqual(floors[index] ?? 0);
      expect(middle).toBeLessThanOrEqual(ceilings[index] ?? 0);
    }
    expect(Math.max(...ceilings)).toBe(SESSION_EVENT_STREAM_BACKOFF.ceilingMs);
  });

  test('clamps a jitter draw that is outside the unit interval', () => {
    // Arrange/Act — the injected draw is the one input here no type can bound.
    const below = sessionEventStreamDelayMs(0, -5);
    const above = sessionEventStreamDelayMs(0, 12);
    const negativeAttempt = sessionEventStreamDelayMs(-3, 0);

    // Assert — a broken generator can make the schedule no faster and no slower than its own bounds.
    expect(below).toBe(sessionEventStreamDelayMs(0, 0));
    expect(above).toBe(sessionEventStreamDelayMs(0, 1));
    expect(negativeAttempt).toBe(sessionEventStreamDelayMs(0, 0));
  });

  test('derives the silence budget from the cadence the daemon declared', () => {
    // Assert — three of the daemon's OWN windows, once it has said what its window is.
    expect(sessionEventStreamDeadlineMs(undefined)).toBe(90_000);
    expect(sessionEventStreamDeadlineMs(30)).toBe(90_000);
    expect(sessionEventStreamDeadlineMs(60)).toBe(180_000);
  });

  test('clamps a declared cadence at both ends before it becomes a timeout', () => {
    // Arrange — `idleSeconds` is a positive integer on the wire and nothing narrower, and the daemon
    // on the other end of a rendezvous is not necessarily the one anybody meant.
    const { missedWindows, minWindowMs, maxWindowMs } = SESSION_EVENT_STREAM_SILENCE;

    // Act/Assert — too short would make this end reconnect over ordinary jitter.
    expect(sessionEventStreamDeadlineMs(1)).toBe(missedWindows * minWindowMs);
    // Too long is the quieter failure: one frame claiming a day-long window would push the deadline
    // past any session anybody will ever have open, which does not weaken the watchdog, it deletes
    // it — and leaves exactly the silent permanent stall this model exists to end.
    expect(sessionEventStreamDeadlineMs(86_400)).toBe(missedWindows * maxWindowMs);
    expect(sessionEventStreamDeadlineMs(Number.POSITIVE_INFINITY)).toBe(missedWindows * minWindowMs);
    expect(sessionEventStreamDeadlineMs(Number.NaN)).toBe(missedWindows * minWindowMs);
    expect(sessionEventStreamDeadlineMs(-10)).toBe(missedWindows * minWindowMs);
  });
});

describe('the live feed subscription', () => {
  test('subscribes once at the resumption cursor and starts out unproved', () => {
    // Arrange/Act
    const harness = subject({ after: 41 });

    // Assert — `connecting` and not `live`: constructing a socket is not evidence a daemon is on the
    // other end of it, and the transport has no open callback that could say otherwise.
    expect(harness.transport.attempts).toHaveLength(1);
    expect(harness.transport.last.after).toBe(41);
    expect(harness.transport.last.sessionId).toBe('s1');
    expect(harness.control.status()).toBe('connecting');
    expect(harness.statuses).toEqual([]);
    harness.control.stop();
  });

  test('goes live on a delivered event and carries the cursor forward', () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.emit(event(7));
    harness.transport.last.emit(event(9));

    // Assert
    expect(harness.statuses).toEqual(['live']);
    expect(harness.events.map(value => value.sequence)).toEqual([7, 9]);
    harness.control.stop();
  });

  test('goes live on an idle proof alone, which is all a quiet session ever sends', () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.idle(idleFrame(30));

    // Assert — without this, a session nobody is typing into could never leave `connecting`, and the
    // daemon's recurring proof would be traffic no reader was any better off for.
    expect(harness.statuses).toEqual(['live']);
    expect(harness.events).toEqual([]);
    harness.control.stop();
  });

  test('schedules a reconnection when the stream ends cleanly', async () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.end();
    await settle();

    // Assert — a resolved stream and a rejected one mean the same thing to a reader: the feed
    // stopped. Silently accepting the resolution is the original defect.
    expect(harness.statuses).toEqual(['reconnecting']);
    expect(harness.clock.delays).toEqual([500]);
    expect(harness.transport.attempts).toHaveLength(1);
    harness.control.stop();
  });

  test('schedules a reconnection when the stream rejects', async () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.fail();
    await settle();

    // Assert
    expect(harness.statuses).toEqual(['reconnecting']);
    expect(harness.clock.delays).toEqual([500]);
    harness.control.stop();
  });

  test('reopens at the cursor it reached, not at zero', async () => {
    // Arrange
    const harness = subject();
    harness.transport.last.emit(event(12));

    // Act
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(500);

    // Assert — resuming from zero would replay the whole tail into the transcript on every flap.
    expect(harness.transport.attempts).toHaveLength(2);
    expect(harness.transport.last.after).toBe(12);
    harness.control.stop();
  });

  test('walks the backoff up while the daemon stays gone', async () => {
    // Arrange — the floor of every window, so the sequence is exact rather than merely bounded.
    const harness = subject();
    const seen: number[] = [];

    // Act
    for (let round = 0; round < 4; round += 1) {
      harness.transport.last.fail();
      await settle();
      const delay = harness.clock.delays[0] ?? -1;
      seen.push(delay);
      harness.clock.fire(delay);
    }

    // Assert — one status change for the whole run: `reconnecting` is not re-announced every window.
    expect(seen).toEqual([500, 1_000, 2_000, 4_000]);
    expect(harness.statuses).toEqual(['reconnecting']);
    expect(harness.transport.attempts).toHaveLength(5);
    harness.control.stop();
  });

  test('restores the whole budget once a frame proves the path again', async () => {
    // Arrange
    const harness = subject();
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(500);
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(1_000);

    // Act — the third attempt actually connects and the daemon proves it is merely quiet.
    harness.transport.last.idle(idleFrame(30));
    harness.transport.last.fail();
    await settle();

    // Assert — back to the first window. A stream that reconnects, sits quiet for an hour and then
    // flaps must not resume at the backoff it reached an hour ago.
    expect(harness.statuses).toEqual(['reconnecting', 'live', 'reconnecting']);
    expect(harness.clock.delays).toEqual([500]);
    harness.control.stop();
  });

  test('stops trying when the attempt budget is exhausted and says so', async () => {
    // Arrange — a two-attempt budget, so exhaustion is reachable without asserting eight windows.
    const harness = subject({ attemptBudget: 2 });

    // Act
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(500);
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(1_000);
    harness.transport.last.fail();
    await settle();

    // Assert — three subscriptions, then an honest stop: nothing is scheduled, nothing is open, and
    // the reader is told rather than left looking at a page that claims to be live.
    expect(harness.transport.attempts).toHaveLength(3);
    expect(harness.statuses).toEqual(['reconnecting', 'disconnected']);
    expect(harness.control.status()).toBe('disconnected');
    expect(harness.clock.armed).toEqual([]);
    harness.control.stop();
  });
});

describe('the live feed silence watchdog', () => {
  test('treats a subscription that hears nothing at all as an ended one', async () => {
    // Arrange — the failure that strands a browser: a blackholed path, where the socket survives, no
    // close ever arrives, and the awaited promise stays pending forever.
    const harness = subject();
    expect(harness.clock.delays).toEqual([DEADLINE]);

    // Act
    harness.clock.fire(DEADLINE);
    await settle();

    // Assert — cancelled from this end, and then handled exactly like a close.
    expect(harness.transport.attempts[0]?.signal?.aborted).toBe(true);
    expect(harness.statuses).toEqual(['reconnecting']);
    expect(harness.clock.delays).toEqual([500]);
    harness.control.stop();
  });

  test('schedules exactly one reconnection when the cancelled socket then settles', async () => {
    // Arrange
    const harness = subject();

    // Act — cancelling a blackholed socket is precisely what finally makes its promise settle, so
    // both ends of the same attempt fire.
    harness.clock.fire(DEADLINE);
    harness.transport.last.fail();
    await settle();

    // Assert — one attempt has one end. Two would leave the browser holding two live streams.
    expect(harness.clock.delays).toEqual([500]);
    harness.clock.fire(500);
    expect(harness.transport.attempts).toHaveLength(2);
    harness.control.stop();
  });

  test('re-arms on every frame, so an active stream is never judged silent', () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.emit(event(1));
    harness.transport.last.idle(idleFrame(30));

    // Assert — one deadline outstanding, not three: each frame replaces the window rather than
    // stacking another one behind it.
    expect(harness.clock.delays).toEqual([DEADLINE]);
    harness.control.stop();
  });

  test('widens the deadline to the cadence the daemon actually declared', () => {
    // Arrange
    const harness = subject();

    // Act — a daemon tuned to a two-minute idle window says so in the proof itself.
    harness.transport.last.idle(idleFrame(120));

    // Assert — the deadline is derived from the wire rather than from a second copy of a number the
    // daemon owns, so tuning the daemon cannot silently make this end trigger-happy.
    expect(harness.clock.delays).toEqual([sessionEventStreamDeadlineMs(120)]);
    harness.control.stop();
  });

  test('keeps the learned cadence across a reconnection', async () => {
    // Arrange
    const harness = subject();
    harness.transport.last.idle(idleFrame(120));

    // Act
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(500);

    // Assert — relearning from scratch would judge the reopened stream against a window three times
    // shorter than the one the daemon told it about.
    expect(harness.clock.delays).toEqual([sessionEventStreamDeadlineMs(120)]);
    harness.control.stop();
  });

  test('arms no deadline while it is waiting out a backoff window', async () => {
    // Arrange
    const harness = subject();

    // Act
    harness.transport.last.fail();
    await settle();

    // Assert — there is no socket to watch between attempts, and a watchdog left running over the
    // gap would fire against the reconnection it is not yet watching.
    expect(harness.clock.delays).toEqual([500]);
    harness.control.stop();
  });
});

describe('the live feed manual reconnect', () => {
  test('restarts immediately from an exhausted schedule', async () => {
    // Arrange
    const harness = subject({ attemptBudget: 1 });
    harness.transport.last.fail();
    await settle();
    harness.clock.fire(500);
    harness.transport.last.fail();
    await settle();
    expect(harness.control.status()).toBe('disconnected');

    // Act
    harness.control.reconnect();

    // Assert — the whole point of a bounded budget: giving up is recoverable in one click, with no
    // window to wait out and the full budget restored.
    expect(harness.transport.attempts).toHaveLength(3);
    expect(harness.statuses).toEqual(['reconnecting', 'disconnected', 'connecting']);
    harness.transport.last.fail();
    await settle();
    expect(harness.clock.delays).toEqual([500]);
    harness.control.stop();
  });

  test('cancels the pending window instead of racing it', async () => {
    // Arrange
    const harness = subject();
    harness.transport.last.fail();
    await settle();
    expect(harness.clock.delays).toEqual([500]);

    // Act
    harness.control.reconnect();

    // Assert — the abandoned window is gone, not merely ignored, so the reader's click cannot end up
    // opening a second stream a moment later. One deadline is armed: the new attempt's own.
    expect(harness.transport.attempts).toHaveLength(2);
    expect(harness.clock.delays).toEqual([DEADLINE]);
    harness.control.stop();
  });

  test('cancels a live subscription rather than opening a second one', () => {
    // Arrange
    const harness = subject();
    harness.transport.last.emit(event(3));

    // Act
    harness.control.reconnect();

    // Assert — the old socket is cancelled and the new one resumes at the cursor the old one reached.
    expect(harness.transport.attempts[0]?.signal?.aborted).toBe(true);
    expect(harness.transport.attempts).toHaveLength(2);
    expect(harness.transport.last.after).toBe(3);
    harness.control.stop();
  });

  test('does nothing at all once the owner has stopped the feed', () => {
    // Arrange
    const harness = subject();
    harness.control.stop();

    // Act — a click delivered from a React tree that has already unmounted.
    harness.control.reconnect();

    // Assert
    expect(harness.transport.attempts).toHaveLength(1);
    expect(harness.statuses).toEqual([]);
  });
});

describe('the live feed teardown', () => {
  test('cancels an open socket and the deadline watching it', () => {
    // Arrange — torn down mid-stream, which is what a route unmount actually is.
    const harness = subject();

    // Act
    harness.control.stop();

    // Assert
    expect(harness.transport.attempts[0]?.signal?.aborted).toBe(true);
    expect(harness.clock.armed).toEqual([]);
  });

  test('cancels a scheduled reconnection when it is torn down between attempts', async () => {
    // Arrange — the OTHER half of the loop. There is no socket here to abort; what would leak is the
    // retry timer, and it would reopen a stream for a route React has already unmounted.
    const harness = subject();
    harness.transport.last.fail();
    await settle();
    expect(harness.clock.delays).toEqual([500]);

    // Act
    harness.control.stop();

    // Assert
    expect(harness.clock.armed).toEqual([]);
    expect(harness.transport.attempts).toHaveLength(1);
  });

  test('is idempotent and publishes nothing', () => {
    // Arrange
    const harness = subject();

    // Act
    harness.control.stop();
    harness.control.stop();

    // Assert — the owner tearing this down is not news anyone is left to hear.
    expect(harness.statuses).toEqual([]);
    expect(harness.control.status()).toBe('connecting');
  });

  test('ignores a late frame from a socket it already abandoned', async () => {
    // Arrange — a cancelled transport is not obliged to fall silent instantly; a relayed session in
    // particular settles across the network.
    const harness = subject();
    const abandoned = harness.transport.last;
    harness.control.reconnect();

    // Act
    abandoned.emit(event(99));
    abandoned.idle(idleFrame(600));
    abandoned.fail();
    await settle();

    // Assert — no host refresh, no cursor jump past the replacement, no budget reset, no deadline
    // widened by a daemon that is no longer on the other end, and no second retry scheduled.
    expect(harness.events).toEqual([]);
    expect(harness.clock.delays).toEqual([DEADLINE]);
    harness.transport.last.fail();
    await settle();
    expect(harness.transport.last.after).toBe(0);
    harness.control.stop();
  });

  test('ignores a late frame from an attempt that ended while its retry was pending', async () => {
    // Arrange — the gap a generation alone does not close. A settlement schedules the reconnection
    // WITHOUT advancing the generation, because the replacement has not been opened yet, so for the
    // whole length of the backoff window the dead attempt still carries the newest one.
    const harness = subject();
    const settled = harness.transport.last;
    settled.emit(event(5));
    settled.fail();
    await settle();
    expect(harness.statuses).toEqual(['live', 'reconnecting']);
    expect(harness.clock.delays).toEqual([500]);

    // Act — the transport that already ended keeps talking.
    settled.emit(event(6));
    settled.idle(idleFrame(120));
    settled.fail();
    await settle();

    // Assert — nothing it says counts. No `live` over a feed that has stopped, no restored budget,
    // no cursor move, no deadline armed for a socket nobody holds, and EXACTLY one retry pending
    // rather than a second scheduled beside it.
    expect(harness.statuses).toEqual(['live', 'reconnecting']);
    expect(harness.control.status()).toBe('reconnecting');
    expect(harness.events.map(value => value.sequence)).toEqual([5]);
    expect(harness.clock.delays).toEqual([500]);

    // And the budget really was not restored: the reconnection resumes at the cursor the live frame
    // reached, and the window after it is the SECOND one, not the first over again.
    harness.clock.fire(500);
    expect(harness.transport.attempts).toHaveLength(2);
    expect(harness.transport.last.after).toBe(5);
    harness.transport.last.fail();
    await settle();
    expect(harness.clock.delays).toEqual([1_000]);
    harness.control.stop();
  });

  test('ignores a late frame delivered after teardown', () => {
    // Arrange
    const harness = subject();
    const abandoned = harness.transport.last;

    // Act
    harness.control.stop();
    abandoned.emit(event(4));
    abandoned.idle(idleFrame(30));

    // Assert — an unmounted route must not be told anything, and `setState` on one is exactly the
    // shape of bug this guard exists to make impossible.
    expect(harness.events).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test('ignores a stream that settles after teardown', async () => {
    // Arrange
    const harness = subject();
    const abandoned = harness.transport.last;

    // Act
    harness.control.stop();
    abandoned.fail();
    await settle();

    // Assert — no reconnection is scheduled for a feed nobody is reading.
    expect(harness.clock.armed).toEqual([]);
    expect(harness.transport.attempts).toHaveLength(1);
  });

  test('ignores a watchdog that fires against an abandoned attempt', async () => {
    // Arrange — a clock that has already handed out the callback cannot un-hand it, so the guard has
    // to live inside the callback rather than only in the cancellation.
    const clock = new ManualClock();
    const transport = new ScriptedStream();
    const statuses: SessionEventStreamStatus[] = [];
    const control = startSessionEventStream({
      api: { stream: transport.stream },
      sessionId: 's1',
      environment: clock.environment,
      onEvent: () => undefined,
      onStatus: status => statuses.push(status),
    });
    const stale = clock.armed[0];

    // Act
    control.reconnect();
    stale?.run();
    await settle();

    // Assert — the replacement is untouched: still one deadline, still unproved, nothing scheduled.
    // No status was published at all, because `connecting` never stopped being true — a state that
    // did not change is not an announcement, which is what keeps this out of a live region's mouth.
    expect(statuses).toEqual([]);
    expect(control.status()).toBe('connecting');
    expect(clock.delays).toEqual([DEADLINE]);
    expect(transport.attempts).toHaveLength(2);
    control.stop();
  });
});
