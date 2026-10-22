import { describe, expect, it } from 'bun:test';
import '../support/dom.ts';
import {
  browserConnectionHealthEnvironment,
  type CarrierOutage,
  CONNECTION_STALL_MS,
  type ConnectionHealthEnvironment,
  DaemonConnectionHealth,
  likelyCause,
  RECONNECT_BASE_MS,
  RECONNECT_CEILING_MS,
  type ReconnectAttempt,
  reconnectDelayMs,
} from '../../src/lib/connection-health.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const laptop = 'daemon-laptop' as DaemonId;
const workstation = 'daemon-workstation' as DaemonId;
const phone = 'daemon-phone' as DaemonId;

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

const outage = (over: Partial<CarrierOutage> = {}): CarrierOutage => ({
  failures: [],
  daemonAbsent: false,
  relaysNeverOpened: false,
  ...over,
});

interface Timer {
  readonly run: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

interface Call {
  readonly daemonId: DaemonId;
  readonly resolve: () => void;
  readonly reject: () => void;
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

const world = () => {
  let now = 10_000;
  let random = 0;
  let online = true;
  const timers: Timer[] = [];
  const calls: Call[] = [];
  const fake = {
    timers,
    calls,
    onCall: undefined as ((daemonId: DaemonId) => void) | undefined,
    setRandom: (next: number) => {
      random = next;
    },
    setOnline: (next: boolean) => {
      online = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    pending: (): Timer[] => timers.filter(timer => !timer.cancelled && !timer.fired),
    retryTimers: (): Timer[] => fake.pending().filter(timer => timer.delayMs !== CONNECTION_STALL_MS),
    stallTimers: (): Timer[] => fake.pending().filter(timer => timer.delayMs === CONNECTION_STALL_MS),
    fire: (timer: Timer): void => {
      timer.fired = true;
      timer.run();
    },
  };
  const environment: ConnectionHealthEnvironment = {
    now: () => now,
    random: () => random,
    isOnline: () => online,
    schedule: (run, delayMs) => {
      const timer: Timer = { run, delayMs, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const attempt: ReconnectAttempt = daemonId => {
    const promise = new Promise<unknown>((resolve, reject) => {
      calls.push({ daemonId, resolve: () => resolve(undefined), reject: () => reject(new Error('still down')) });
    });
    fake.onCall?.(daemonId);
    return promise;
  };
  return { ...fake, environment, attempt };
};

const reconnectingOf = (health: DaemonConnectionHealth, daemonId: DaemonId) => {
  const state = health.state(daemonId);
  if (state.kind !== 'reconnecting') throw new Error(`expected reconnecting, got ${state.kind}`);
  return state;
};

describe('reconnectDelayMs', () => {
  it('waits between half and all of the capped exponential delay (equal jitter)', () => {
    expect(reconnectDelayMs(0, 0)).toBe(RECONNECT_BASE_MS / 2);
    expect(reconnectDelayMs(0, 1)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelayMs(0, 0.5)).toBe(RECONNECT_BASE_MS * 0.75);
  });

  it('retries a drop inside 300 ms, then doubles per attempt from the 300 ms base', () => {
    expect(reconnectDelayMs(0, 1)).toBeLessThanOrEqual(300);
    expect(reconnectDelayMs(1, 0)).toBe(300);
    expect(reconnectDelayMs(1, 1)).toBe(600);
    expect(reconnectDelayMs(2, 1)).toBe(1_200);
    expect(reconnectDelayMs(3, 1)).toBe(2_400);
    expect(reconnectDelayMs(4, 1)).toBe(4_800);
    expect(reconnectDelayMs(5, 1)).toBe(9_600);
  });

  it('never exceeds the ten second ceiling, whatever the attempt number', () => {
    expect(reconnectDelayMs(6, 0)).toBe(RECONNECT_CEILING_MS / 2);
    expect(reconnectDelayMs(6, 1)).toBe(RECONNECT_CEILING_MS);
    for (const attempt of [7, 29, 30, 31, 1_000, 1_000_000]) {
      expect(reconnectDelayMs(attempt, 0)).toBe(RECONNECT_CEILING_MS / 2);
      expect(reconnectDelayMs(attempt, 1)).toBe(RECONNECT_CEILING_MS);
    }
  });
});

describe('likelyCause', () => {
  it('lets the device saying it is offline win over everything it observed', () => {
    expect(likelyCause(outage({ daemonAbsent: true, relaysNeverOpened: true }), false)).toBe('device-offline');
  });

  it('calls a relay that answered with no daemon behind it daemon-unreachable', () => {
    expect(likelyCause(outage({ daemonAbsent: true, relaysNeverOpened: true }), true)).toBe('daemon-unreachable');
  });

  it('calls a relay that never opened relay-unreachable', () => {
    expect(likelyCause(outage({ relaysNeverOpened: true }), true)).toBe('relay-unreachable');
  });

  it('says unknown when nothing tells the causes apart', () => {
    expect(likelyCause(outage(), true)).toBe('unknown');
  });
});

describe('DaemonConnectionHealth state', () => {
  it('knows nothing about a daemon nobody has reported on', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
    expect(health.reconnecting()).toEqual([]);
  });

  it('is connected once any request is answered', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.answered(laptop);
    expect(health.state(laptop)).toEqual({ kind: 'connected' });
  });

  it('starts an outage as reconnecting with the age, cause and folded failures it was told', () => {
    const w = world();
    w.setOnline(false);
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(
      laptop,
      outage({
        failures: [
          { label: 'Direct', detail: 'first direct detail' },
          { label: 'Hosted relay', detail: 'relay detail' },
          { label: 'Direct', detail: 'latest direct detail' },
        ],
      }),
    );
    expect(health.state(laptop)).toEqual({
      kind: 'reconnecting',
      since: 10_000,
      attempt: 0,
      nextAttemptAt: 10_000 + reconnectDelayMs(0, 0),
      failures: [
        { label: 'Hosted relay', detail: 'relay detail' },
        { label: 'Direct', detail: 'latest direct detail' },
      ],
      cause: 'device-offline',
      stalled: false,
    });
  });

  it('schedules the first retry at the jittered delay and one stall flip at thirty seconds', () => {
    const w = world();
    w.setRandom(1);
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    expect(w.retryTimers().map(timer => timer.delayMs)).toEqual([RECONNECT_BASE_MS]);
    expect(w.stallTimers().map(timer => timer.delayMs)).toEqual([CONNECTION_STALL_MS]);
    expect(reconnectingOf(health, laptop).nextAttemptAt).toBe(10_000 + RECONNECT_BASE_MS);
  });

  it('keeps since and attempt when the same outage is measured again, but takes the new failures and cause', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage({ failures: [{ label: 'Direct', detail: 'refused' }] }));
    w.advance(4_000);
    w.setOnline(false);
    health.outage(
      laptop,
      outage({
        failures: [{ label: 'Hosted relay', detail: 'closed' }],
        daemonAbsent: true,
      }),
    );
    const state = reconnectingOf(health, laptop);
    expect(state.since).toBe(10_000);
    expect(state.attempt).toBe(0);
    expect(state.failures).toEqual([{ label: 'Hosted relay', detail: 'closed' }]);
    expect(state.cause).toBe('device-offline');
    expect(w.stallTimers()).toHaveLength(1);
    expect(w.retryTimers()).toHaveLength(1);
  });

  it('lists exactly the daemons that are reconnecting', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    health.answered(workstation);
    health.subscribe(phone, () => undefined);
    health.outage(phone, outage());
    health.outage(workstation, outage());
    health.answered(workstation);
    expect(health.reconnecting()).toEqual([laptop, phone]);
  });
});

describe('DaemonConnectionHealth reconnect loop', () => {
  it('runs forever: twenty failing retries later it still schedules the next, never past ten seconds', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    w.onCall = id => health.outage(id, outage({ failures: [{ label: 'Direct', detail: 'refused' }] }));
    health.outage(laptop, outage());
    for (let index = 0; index < 20; index += 1) {
      const [timer, ...others] = w.retryTimers();
      expect(others).toEqual([]);
      const scheduled = must(timer, `retry timer ${index}`);
      expect(scheduled.delayMs).toBe(reconnectDelayMs(index, 0));
      expect(scheduled.delayMs).toBeLessThanOrEqual(RECONNECT_CEILING_MS);
      expect(reconnectingOf(health, laptop).nextAttemptAt).toBe(w.now() + scheduled.delayMs);
      w.fire(scheduled);
      expect(w.calls).toHaveLength(index + 1);
      expect(reconnectingOf(health, laptop).attempt).toBe(index + 1);
      must(w.calls[index], `call ${index}`).resolve();
      await settle();
      expect(health.state(laptop).kind).toBe('reconnecting');
    }
    expect(w.retryTimers()).toHaveLength(1);
    expect(w.calls.every(call => call.daemonId === laptop)).toBe(true);
  });

  it('has no next attempt time while an attempt is in flight, and a new one once it ends', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    expect(reconnectingOf(health, laptop).nextAttemptAt).toBeNull();
    expect(w.retryTimers()).toEqual([]);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(reconnectingOf(health, laptop).nextAttemptAt).not.toBeNull();
    expect(w.retryTimers()).toHaveLength(1);
  });

  it('treats an attempt that rejects as over and keeps retrying', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    must(w.calls[0], 'call').reject();
    await settle();
    expect(health.state(laptop).kind).toBe('reconnecting');
    expect(w.retryTimers()).toHaveLength(1);
  });

  it('treats an attempt that throws synchronously as over and keeps retrying', async () => {
    const w = world();
    let thrown = 0;
    const health = new DaemonConnectionHealth(w.environment, () => {
      thrown += 1;
      throw new Error('router unavailable');
    });
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    await settle();
    expect(thrown).toBe(1);
    expect(reconnectingOf(health, laptop).attempt).toBe(1);
    expect(reconnectingOf(health, laptop).nextAttemptAt).not.toBeNull();
    expect(w.retryTimers()).toHaveLength(1);
  });

  it('schedules the next attempt when a recovery and a fresh outage both landed under one slow attempt', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    health.answered(laptop);
    health.outage(laptop, outage());
    expect(health.state(laptop).kind).toBe('reconnecting');
    expect(w.retryTimers()).toEqual([]);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(w.retryTimers()).toHaveLength(1);
    expect(reconnectingOf(health, laptop).nextAttemptAt).not.toBeNull();
  });

  it('schedules nothing when the attempt ends after the daemon recovered', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    health.answered(laptop);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(health.state(laptop)).toEqual({ kind: 'connected' });
    expect(w.pending()).toEqual([]);
  });
});

describe('DaemonConnectionHealth retryNow', () => {
  it('cancels the pending timer and attempts immediately', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    const timer = must(w.retryTimers()[0], 'retry timer');
    health.retryNow(laptop);
    expect(timer.cancelled).toBe(true);
    expect(w.calls).toHaveLength(1);
    expect(reconnectingOf(health, laptop).attempt).toBe(1);
    expect(reconnectingOf(health, laptop).nextAttemptAt).toBeNull();
  });

  it('coalesces a second call while one attempt is in flight into the same attempt', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    health.retryNow(laptop);
    health.retryNow(laptop);
    expect(w.calls).toHaveLength(1);
    expect(reconnectingOf(health, laptop).attempt).toBe(1);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(w.retryTimers()).toHaveLength(1);
    health.retryNow(laptop);
    expect(w.calls).toHaveLength(2);
  });

  it('does nothing for a daemon nothing was ever reported about', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.retryNow(laptop);
    expect(w.calls).toEqual([]);
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
  });

  it('does nothing for a daemon that is connected or whose state is still unknown', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.answered(laptop);
    health.subscribe(workstation, () => undefined);
    health.retryNow(laptop);
    health.retryNow(workstation);
    expect(w.calls).toEqual([]);
    expect(w.timers).toEqual([]);
  });
});

describe('DaemonConnectionHealth stall', () => {
  it('flips stalled when the stall timer fires and tells every subscriber', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let heard = 0;
    health.subscribe(laptop, () => {
      heard += 1;
    });
    health.outage(laptop, outage());
    const before = heard;
    expect(reconnectingOf(health, laptop).stalled).toBe(false);
    w.advance(CONNECTION_STALL_MS);
    w.fire(must(w.stallTimers()[0], 'stall timer'));
    expect(reconnectingOf(health, laptop).stalled).toBe(true);
    expect(heard).toBe(before + 1);
  });

  it('keeps since, attempt and failures when it flips', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage({ failures: [{ label: 'Direct', detail: 'refused' }] }));
    w.fire(must(w.stallTimers()[0], 'stall timer'));
    const state = reconnectingOf(health, laptop);
    expect(state.since).toBe(10_000);
    expect(state.failures).toEqual([{ label: 'Direct', detail: 'refused' }]);
    expect(w.stallTimers()).toEqual([]);
  });

  it('cancels the stall timer on recovery, and an old one that still runs does nothing', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let heard = 0;
    health.subscribe(laptop, () => {
      heard += 1;
    });
    health.outage(laptop, outage());
    const stale = must(w.stallTimers()[0], 'stall timer');
    health.answered(laptop);
    expect(stale.cancelled).toBe(true);
    const afterRecovery = heard;
    stale.run();
    expect(health.state(laptop)).toEqual({ kind: 'connected' });
    expect(heard).toBe(afterRecovery);
  });

  it('does not stall a fresh outage because of the stall timer of an older one', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    const stale = must(w.stallTimers()[0], 'stall timer');
    health.answered(laptop);
    health.outage(laptop, outage());
    stale.run();
    expect(reconnectingOf(health, laptop).stalled).toBe(false);
  });
});

describe('DaemonConnectionHealth recovery', () => {
  it('fires each onRecovered listener exactly once when a reconnecting daemon answers', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    const heard: string[] = [];
    health.onRecovered(laptop, () => heard.push('a'));
    health.onRecovered(laptop, () => heard.push('b'));
    health.onRecovered(workstation, () => heard.push('other daemon'));
    health.outage(laptop, outage());
    health.answered(laptop);
    expect(heard).toEqual(['a', 'b']);
    expect(health.state(laptop)).toEqual({ kind: 'connected' });
  });

  it('cancels the retry and the stall timer on recovery', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    health.answered(laptop);
    expect(w.pending()).toEqual([]);
  });

  it('fires nothing when a connected daemon answers again, and publishes nothing', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let recovered = 0;
    let published = 0;
    health.onRecovered(laptop, () => {
      recovered += 1;
    });
    health.subscribe(laptop, () => {
      published += 1;
    });
    health.outage(laptop, outage());
    health.answered(laptop);
    const publishedAtRecovery = published;
    health.answered(laptop);
    health.answered(laptop);
    expect(recovered).toBe(1);
    expect(published).toBe(publishedAtRecovery);
  });

  it('fires nothing when a daemon goes from unknown straight to connected', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let recovered = 0;
    health.onRecovered(laptop, () => {
      recovered += 1;
    });
    health.answered(laptop);
    expect(recovered).toBe(0);
  });

  it('fires nothing when a daemon returns to connected from a settled (unknown) state', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let recovered = 0;
    health.onRecovered(laptop, () => {
      recovered += 1;
    });
    health.outage(laptop, outage());
    health.settled(laptop);
    health.answered(laptop);
    expect(recovered).toBe(0);
  });

  it('lets a throwing onRecovered listener fail without stopping the others', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    const heard: string[] = [];
    health.onRecovered(laptop, () => {
      throw new Error('one surface failed to refresh');
    });
    health.onRecovered(laptop, () => heard.push('survivor'));
    health.outage(laptop, outage());
    expect(() => health.answered(laptop)).not.toThrow();
    expect(heard).toEqual(['survivor']);
  });

  it('hears a second outage and recovery as a fresh cycle', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let recovered = 0;
    health.onRecovered(laptop, () => {
      recovered += 1;
    });
    health.outage(laptop, outage());
    health.answered(laptop);
    w.advance(5_000);
    health.outage(laptop, outage());
    expect(reconnectingOf(health, laptop).since).toBe(15_000);
    expect(reconnectingOf(health, laptop).attempt).toBe(0);
    health.answered(laptop);
    expect(recovered).toBe(2);
  });
});

describe('DaemonConnectionHealth settled', () => {
  it('goes back to unknown and stops the loop: no timer fires afterwards', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    const timers = w.pending();
    expect(timers).toHaveLength(2);
    health.settled(laptop);
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
    expect(timers.every(timer => timer.cancelled)).toBe(true);
    expect(w.pending()).toEqual([]);
    expect(health.reconnecting()).toEqual([]);
  });

  it('does not schedule another attempt when the attempt in flight ends after it settled', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    w.fire(must(w.retryTimers()[0], 'retry timer'));
    health.settled(laptop);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
    expect(w.pending()).toEqual([]);
  });

  it('is a no-op for a daemon nothing was reported about', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    expect(() => health.settled(laptop)).not.toThrow();
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
  });
});

describe('DaemonConnectionHealth clearDaemon', () => {
  it('stops the loop, resets to unknown and tells subscribers', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    const seen: string[] = [];
    health.subscribe(laptop, () => seen.push(health.state(laptop).kind));
    health.outage(laptop, outage());
    seen.length = 0;
    health.clearDaemon(laptop);
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
    expect(seen).toEqual(['unknown']);
    expect(w.pending()).toEqual([]);
  });

  it('leaves existing subscribers hearing later changes for that daemon', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    const seen: string[] = [];
    health.subscribe(laptop, () => seen.push(health.state(laptop).kind));
    health.outage(laptop, outage());
    health.clearDaemon(laptop);
    seen.length = 0;
    health.outage(laptop, outage());
    expect(seen).toContain('reconnecting');
    health.answered(laptop);
    expect(seen.at(-1)).toBe('connected');
  });

  it('is a no-op for a daemon nothing was reported about', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    expect(() => health.clearDaemon(laptop)).not.toThrow();
    expect(health.state(laptop)).toEqual({ kind: 'unknown' });
  });

  it('publishes nothing when the daemon is already unknown', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let heard = 0;
    health.subscribe(laptop, () => {
      heard += 1;
    });
    health.clearDaemon(laptop);
    expect(heard).toBe(0);
  });

  it('does not run an attempt that was in flight after the pairing is cleared', async () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    health.outage(laptop, outage());
    health.retryNow(laptop);
    health.clearDaemon(laptop);
    must(w.calls[0], 'call').resolve();
    await settle();
    expect(w.calls).toHaveLength(1);
    expect(w.pending()).toEqual([]);
  });
});

describe('DaemonConnectionHealth subscriptions', () => {
  it('stops telling a subscriber that unsubscribed', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let kept = 0;
    let dropped = 0;
    health.subscribe(laptop, () => {
      kept += 1;
    });
    const unsubscribe = health.subscribe(laptop, () => {
      dropped += 1;
    });
    unsubscribe();
    health.outage(laptop, outage());
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBe(0);
  });

  it('stops telling a recovery listener that unsubscribed', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let kept = 0;
    let dropped = 0;
    health.onRecovered(laptop, () => {
      kept += 1;
    });
    const unsubscribe = health.onRecovered(laptop, () => {
      dropped += 1;
    });
    unsubscribe();
    health.outage(laptop, outage());
    health.answered(laptop);
    expect(kept).toBe(1);
    expect(dropped).toBe(0);
  });

  it('keeps the daemons apart', () => {
    const w = world();
    const health = new DaemonConnectionHealth(w.environment, w.attempt);
    let workstationHeard = 0;
    health.subscribe(workstation, () => {
      workstationHeard += 1;
    });
    health.outage(laptop, outage());
    expect(workstationHeard).toBe(0);
    expect(health.state(workstation)).toEqual({ kind: 'unknown' });
  });
});

describe('browserConnectionHealthEnvironment', () => {
  const withNavigator = (value: unknown, body: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
    try {
      body();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'navigator');
      else Object.defineProperty(globalThis, 'navigator', original);
    }
  };

  it('reads the wall clock and a random number in [0, 1)', () => {
    const environment = browserConnectionHealthEnvironment();
    const before = Date.now();
    const now = environment.now();
    expect(typeof now).toBe('number');
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    for (let index = 0; index < 20; index += 1) {
      const random = environment.random();
      expect(random).toBeGreaterThanOrEqual(0);
      expect(random).toBeLessThan(1);
    }
  });

  it('schedules through setTimeout and cancels through clearTimeout', () => {
    const environment = browserConnectionHealthEnvironment();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: { run: () => void; delayMs: number }[] = [];
    const cleared: unknown[] = [];
    const handle = { fake: 'handle' };
    globalThis.setTimeout = ((run: () => void, delayMs: number) => {
      scheduled.push({ run, delayMs });
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((value: unknown) => {
      cleared.push(value);
    }) as unknown as typeof clearTimeout;
    try {
      const run = () => undefined;
      const cancel = environment.schedule(run, 1_234);
      expect(scheduled).toEqual([{ run, delayMs: 1_234 }]);
      expect(cleared).toEqual([]);
      cancel();
      expect(cleared).toEqual([handle]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it('prevents a cancelled run from ever happening', async () => {
    const environment = browserConnectionHealthEnvironment();
    let ran = false;
    const cancel = environment.schedule(() => {
      ran = true;
    }, 0);
    cancel();
    await Promise.resolve();
    expect(ran).toBe(false);
  });

  it('reads navigator.onLine, and says online when nobody can tell', () => {
    const environment = browserConnectionHealthEnvironment();
    withNavigator({ onLine: false }, () => expect(environment.isOnline()).toBe(false));
    withNavigator({ onLine: true }, () => expect(environment.isOnline()).toBe(true));
    withNavigator({}, () => expect(environment.isOnline()).toBe(true));
    withNavigator(undefined, () => expect(environment.isOnline()).toBe(true));
  });
});
