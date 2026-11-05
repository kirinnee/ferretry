/**
 * Proves the small browser adapters of Live voice against plain-object fakes of the page:
 * the clock, the visibility of the document, the one-Live-tab lock, the screen wake lock, the level
 * frames read from a meter-only stream, and the reply feed read from the session view.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { MicMeterPort } from '../../../src/lib/stt/level-monitor.ts';
import { browserClock } from '../../../src/lib/voice-chat/clock.ts';
import { meterLevelFrames } from '../../../src/lib/voice-chat/level-frames.ts';
import { LIVE_LOCK_NAME, webMicLock } from '../../../src/lib/voice-chat/mic-lock.ts';
import type { ClockPort, ReplySignal, VisibilityPort } from '../../../src/lib/voice-chat/ports.ts';
import { type ReplySnapshot, type ReplySource, sessionReplyFeed } from '../../../src/lib/voice-chat/reply-feed.ts';
import { documentVisibility } from '../../../src/lib/voice-chat/visibility.ts';
import { gatedWakeLock, screenWakeLock } from '../../../src/lib/voice-chat/wake-lock.ts';

describe('browserClock', () => {
  it('reads performance.now and runs, and cancels, timers', () => {
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let next = 1;
    const clock = browserClock({
      performance: { now: () => 1234 },
      setTimeout: (callback, ms) => {
        timers.set(next, callback);
        should(ms).be.aboveOrEqual(0);
        return next++;
      },
      clearTimeout: handle => void cleared.push(handle as unknown as number),
    });
    should(clock.now()).equal(1234);
    let ran = 0;
    clock.after(50, () => {
      ran += 1;
    });
    timers.get(1)?.();
    should(ran).equal(1);
    const cancel = clock.after(-5, () => undefined);
    cancel();
    should(cleared).deepEqual([2]);
  });
});

describe('documentVisibility', () => {
  it('reports visible unless hidden, and tells the watcher on every change', () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_type: 'visibilitychange', listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => void listeners.delete(listener),
    };
    const port = documentVisibility(doc);
    should(port.visible()).be.true();
    const seen: boolean[] = [];
    const stop = port.watch(visible => void seen.push(visible));
    doc.visibilityState = 'hidden';
    for (const listener of listeners) listener();
    doc.visibilityState = 'prerender';
    for (const listener of listeners) listener();
    should(seen).deepEqual([false, true]);
    should(port.visible()).be.true();
    stop();
    should(listeners.size).equal(0);
  });
});

describe('webMicLock', () => {
  type Callback = (lock: unknown) => Promise<unknown> | unknown;
  const locks = (taken: boolean) => {
    const calls: { name: string; ifAvailable: boolean }[] = [];
    let heldUntil: Promise<unknown> | null = null;
    return {
      calls,
      get released() {
        return heldUntil;
      },
      api: {
        request: (name: string, options: { readonly ifAvailable: boolean }, callback: Callback) => {
          calls.push({ name, ifAvailable: options.ifAvailable });
          const result = Promise.resolve(callback(taken ? null : {}));
          heldUntil = result;
          return result;
        },
      },
    };
  };

  it('grants the first tab and holds until release; a held lock is not asked for twice', async () => {
    const fake = locks(false);
    const lock = webMicLock(fake.api);
    should(await lock.acquire()).be.true();
    should(fake.calls).deepEqual([{ name: LIVE_LOCK_NAME, ifAvailable: true }]);
    should(await lock.acquire()).be.true();
    should(fake.calls.length).equal(1);
    let settled = false;
    void fake.released?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    should(settled).be.false();
    lock.release();
    await fake.released;
    should(settled).be.true();
    lock.release();
  });

  it('refuses a second tab, and does not hold anything', async () => {
    const fake = locks(true);
    const lock = webMicLock(fake.api);
    should(await lock.acquire()).be.false();
    lock.release();
  });

  /** A Web Locks whose grant arrives when the test says so, like the browser's asynchronous queue. */
  const slowLocks = () => {
    const waiting: { callback: Callback; settled: Promise<unknown> | null }[] = [];
    return {
      waiting,
      api: {
        request: (_name: string, _options: { readonly ifAvailable: boolean }, callback: Callback) =>
          new Promise<unknown>(resolve => {
            waiting.push({ callback, settled: null });
            resolve(undefined);
          }),
      },
      /** The browser decides the `index`th request: a lock (true) or nothing (false). Returns when it is released. */
      decide: (index: number, available: boolean): Promise<unknown> => {
        const entry = waiting[index];
        if (entry === undefined) throw new Error('no such request');
        entry.settled = Promise.resolve(entry.callback(available ? {} : null));
        return entry.settled;
      },
    };
  };

  it('hands a lock that is granted AFTER release straight back, and tells its asker it did not get it', async () => {
    const fake = slowLocks();
    const lock = webMicLock(fake.api);
    const asked = lock.acquire();
    lock.release();
    const returned = fake.decide(0, true);
    should(await asked).be.false();
    // It was not held: the callback's promise is already settled, so another tab can take the lock at once.
    should(await returned).equal(null);
    // And a later acquire is a fresh ask that can be granted and held.
    const again = lock.acquire();
    const held = fake.decide(1, true);
    should(await again).be.true();
    let settled = false;
    void held.then(() => {
      settled = true;
    });
    await Promise.resolve();
    should(settled).be.false();
    lock.release();
    await held;
    should(settled).be.true();
  });

  it('a request that fails after a release is not a grant', async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const lock = webMicLock({
      request: () =>
        new Promise<unknown>((_, reject) => {
          fail = reject;
        }),
    });
    const asked = lock.acquire();
    lock.release();
    fail(new Error('gone'));
    should(await asked).be.false();
  });

  it('grants without the API, and when the browser refuses the request', async () => {
    should(await webMicLock(undefined).acquire()).be.true();
    // A browser that exposes the property as null (some embedded webviews) has no locks either.
    should(await webMicLock(null).acquire()).be.true();
    const lock = webMicLock({ request: () => Promise.reject(new Error('insecure')) });
    should(await lock.acquire()).be.true();
  });
});

describe('screenWakeLock', () => {
  const visibility = () => {
    const listeners = new Set<(visible: boolean) => void>();
    const port: VisibilityPort = {
      visible: () => true,
      watch: listener => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    return {
      port,
      listeners,
      emit: (visible: boolean) => {
        for (const listener of listeners) listener(visible);
      },
    };
  };
  const sentinels = () => {
    const made: { released: number }[] = [];
    return {
      made,
      api: {
        request: async () => {
          const sentinel = { released: 0 };
          made.push(sentinel);
          return {
            release: async () => {
              sentinel.released += 1;
            },
          };
        },
      },
    };
  };

  it('keeps the screen on, asks again when the page returns, and releases for good', async () => {
    const view = visibility();
    const fake = sentinels();
    const lock = screenWakeLock(fake.api, view.port);
    should(await lock.acquire()).be.true();
    should(await lock.acquire()).be.true();
    should(fake.made.length).equal(1);
    view.emit(false);
    should(fake.made.length).equal(1);
    // The browser dropped the lock while hidden: a fresh sentinel replaces it on return.
    lock.release();
    should(view.listeners.size).equal(0);
    should(fake.made[0]?.released).equal(1);
  });

  it('re-acquires on becoming visible while wanted', async () => {
    const view = visibility();
    const fake = sentinels();
    const lock = screenWakeLock(fake.api, view.port);
    await lock.acquire();
    // Simulate the browser's own release: the sentinel is forgotten by a release-then-watch cycle.
    view.emit(true);
    await Promise.resolve();
    should(fake.made.length).equal(2);
    lock.release();
    lock.release();
  });

  it('does not mind a sentinel that cannot be released', async () => {
    const view = visibility();
    const lock = screenWakeLock(
      { request: async () => ({ release: () => Promise.reject(new Error('gone')) }) },
      view.port,
    );
    await lock.acquire();
    lock.release();
  });

  it('answers false without the API or when the request is refused', async () => {
    const view = visibility();
    should(await screenWakeLock(undefined, view.port).acquire()).be.false();
    should(await screenWakeLock(null, view.port).acquire()).be.false();
    const refused = screenWakeLock({ request: () => Promise.reject(new Error('battery saver')) }, view.port);
    should(await refused.acquire()).be.false();
  });

  it('releases a lock that arrives after release was asked for', async () => {
    const view = visibility();
    let finish: (sentinel: { release(): Promise<void> }) => void = () => undefined;
    const released: number[] = [];
    const lock = screenWakeLock(
      {
        request: () =>
          new Promise(resolve => {
            finish = resolve;
          }),
      },
      view.port,
    );
    const asked = lock.acquire();
    lock.release();
    finish({
      release: () => {
        released.push(1);
        return Promise.reject(new Error('already gone'));
      },
    });
    should(await asked).be.false();
    should(released).deepEqual([1]);
  });

  /** A wake lock API whose grants are decided by hand; `held` is what has been granted and not released. */
  const manual = () => {
    const held = new Set<number>();
    const grants: (() => void)[] = [];
    let requests = 0;
    return {
      held,
      requests: () => requests,
      grantAll: async () => {
        for (const grant of grants.splice(0)) grant();
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      },
      api: {
        request: async () => {
          requests += 1;
          const id = requests;
          await new Promise<void>(resolve => grants.push(resolve));
          held.add(id);
          return {
            release: async () => {
              held.delete(id);
            },
          };
        },
      },
    };
  };

  it('shares one request when the page hides, shows and Live resumes while the first is still pending, and End releases it', async () => {
    const view = visibility();
    const wake = manual();
    const lock = screenWakeLock(wake.api, view.port);
    const first = lock.acquire();
    view.emit(false);
    view.emit(true);
    const second = lock.acquire();
    view.emit(true);
    await wake.grantAll();
    should(await first).be.true();
    should(await second).be.true();
    should(wake.requests()).equal(1);
    should([...wake.held]).deepEqual([1]);
    lock.release();
    await Promise.resolve();
    should(wake.held.size).equal(0);
  });

  it('hands a stale grant straight back when Live ended and began again while it was pending', async () => {
    const view = visibility();
    const wake = manual();
    const lock = screenWakeLock(wake.api, view.port);
    const first = lock.acquire();
    lock.release();
    const second = lock.acquire();
    should(wake.requests()).equal(2);
    await wake.grantAll();
    should(await first).be.false();
    should(await second).be.true();
    // Only the newest grant is held; the stale one went back.
    should([...wake.held]).deepEqual([2]);
    lock.release();
    await Promise.resolve();
    should(wake.held.size).equal(0);
  });

  it('a new sentinel after the page returns replaces the one the browser dropped, and the old one is released', async () => {
    const view = visibility();
    const wake = manual();
    const lock = screenWakeLock(wake.api, view.port);
    const first = lock.acquire();
    await wake.grantAll();
    await first;
    view.emit(false);
    view.emit(true);
    await wake.grantAll();
    should(wake.requests()).equal(2);
    should([...wake.held]).deepEqual([2]);
    lock.release();
    await Promise.resolve();
    should(wake.held.size).equal(0);
  });

  it('a refused request does not block the next one', async () => {
    const view = visibility();
    let calls = 0;
    const lock = screenWakeLock(
      {
        request: async () => {
          calls += 1;
          if (calls === 1) throw new Error('battery saver');
          return { release: async () => undefined };
        },
      },
      view.port,
    );
    should(await lock.acquire()).be.false();
    should(await lock.acquire()).be.true();
    should(calls).equal(2);
    lock.release();
  });

  it('does not mind a replaced sentinel that cannot be released', async () => {
    const view = visibility();
    const lock = screenWakeLock(
      { request: async () => ({ release: () => Promise.reject(new Error('gone')) }) },
      view.port,
    );
    await lock.acquire();
    view.emit(true);
    await Promise.resolve();
    await Promise.resolve();
    lock.release();
  });
});

describe('meterLevelFrames', () => {
  const fakeClock = () => {
    let now = 0;
    const pending: { at: number; run: () => void; live: boolean }[] = [];
    const clock: ClockPort = {
      now: () => now,
      after: (ms, run) => {
        const entry = { at: now + ms, run, live: true };
        pending.push(entry);
        return () => {
          entry.live = false;
        };
      },
    };
    const advance = (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = pending.filter(entry => entry.live && entry.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = due.at;
        due.run();
      }
      now = target;
    };
    return { clock, advance };
  };
  const meter = (amplitude: () => number, options: { tap?: boolean; throws?: boolean } = {}) => {
    const events: string[] = [];
    const analyser = {
      fftSize: 0,
      getFloatTimeDomainData: (buffer: Float32Array) => {
        if (options.throws) throw new Error('detached');
        buffer.fill(amplitude());
      },
    };
    const port: MicMeterPort = {
      open: async () => ({
        monitor: {
          createAnalyser: () =>
            options.tap === false ? null : { analyser, disconnect: () => void events.push('tap.disconnect') },
        },
        release: () => void events.push('meter.release'),
      }),
    };
    return { port, events, analyser };
  };

  it('reads a frame every 20 ms from a read-only analyser and keeps the recent levels', async () => {
    const { clock, advance } = fakeClock();
    let level = 0.1;
    const fake = meter(() => level);
    const frames: { atMs: number; rms: number }[] = [];
    const handle = await meterLevelFrames(fake.port, clock).open(frame => void frames.push(frame));
    should(handle).not.be.null();
    should(fake.analyser.fftSize).equal(1_024);
    advance(60);
    should(frames.map(frame => frame.atMs)).deepEqual([20, 40, 60]);
    should(frames[0]?.rms).be.approximately(0.1, 1e-6);
    level = 0;
    advance(20);
    should(handle?.recent().length).equal(4);
    should(handle?.recent().at(-1)).equal(0);
    handle?.release();
    advance(100);
    should(frames.length).equal(4);
    should(fake.events).deepEqual(['tap.disconnect', 'meter.release']);
  });

  it('keeps only 10 seconds of recent levels', async () => {
    const { clock, advance } = fakeClock();
    const fake = meter(() => 0.05);
    const handle = await meterLevelFrames(fake.port, clock).open(() => undefined);
    advance(20 * 600);
    should(handle?.recent().length).equal(500);
    handle?.release();
  });

  it('skips a frame it cannot read and tries again', async () => {
    const { clock, advance } = fakeClock();
    const fake = meter(() => 0, { throws: true });
    const frames: unknown[] = [];
    const handle = await meterLevelFrames(fake.port, clock).open(frame => void frames.push(frame));
    advance(100);
    should(frames.length).equal(0);
    should(handle?.recent()).deepEqual([]);
    handle?.release();
  });

  it('is null without a meter port, without a microphone, or without Web Audio', async () => {
    const { clock } = fakeClock();
    should(await meterLevelFrames(null, clock).open(() => undefined)).be.null();
    should(await meterLevelFrames({ open: async () => null }, clock).open(() => undefined)).be.null();
    const noTap = meter(() => 0, { tap: false });
    should(await meterLevelFrames(noTap.port, clock).open(() => undefined)).be.null();
    should(noTap.events).deepEqual(['meter.release']);
  });
});

describe('sessionReplyFeed', () => {
  const source = (first: ReplySnapshot | null) => {
    let current = first;
    const listeners = new Set<() => void>();
    const api: ReplySource = {
      current: () => current,
      subscribe: listener => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    return {
      api,
      listeners,
      set(next: ReplySnapshot | null) {
        current = next;
        for (const listener of listeners) listener();
      },
    };
  };
  const snap = (turnState: ReplySnapshot['turnState'], turnStateAt?: string, status = 'running'): ReplySnapshot => ({
    turnState,
    turnStateAt,
    status,
  });

  it('ignores a stale your-turn from before the send, then reports working and done', () => {
    const fake = source(snap('your-turn', 't1'));
    const seen: ReplySignal['kind'][] = [];
    const stop = sessionReplyFeed(fake.api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    fake.set(snap('your-turn', 't1'));
    should(seen).deepEqual([]);
    fake.set(snap('working', 't2'));
    fake.set(snap('working', 't2'));
    fake.set(snap('your-turn', 't3'));
    should(seen).deepEqual(['working', 'done']);
    stop();
    should(fake.listeners.size).equal(0);
  });

  it('counts a changed turnStateAt as the turn having moved, even if working was never seen', () => {
    const fake = source(snap('your-turn', 't1'));
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(fake.api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    fake.set(snap('your-turn', 't2'));
    should(seen).deepEqual(['done']);
  });

  it('starts from working when the session is already working, and reads a question', () => {
    const fake = source(snap('working', 't1'));
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(fake.api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['working']);
    fake.set(snap('needs-input', 't2'));
    should(seen).deepEqual(['working', 'needs-input']);
  });

  it('says nothing for a daemon without turnState, and ends when the session finishes or goes', () => {
    const quiet = source(snap(undefined, undefined));
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(quiet.api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    quiet.set(snap(undefined, undefined));
    should(seen).deepEqual([]);
    // A state that changed but names no turn state (an older daemon) still says nothing.
    quiet.set(snap(undefined, 't9'));
    should(seen).deepEqual([]);
    quiet.set(snap('your-turn', 't1', 'completed'));
    should(seen).deepEqual(['ended']);
    const gone = source(snap('working', 't1'));
    const goneSeen: ReplySignal['kind'][] = [];
    sessionReplyFeed(gone.api)
      .arm()
      .attach(signal => void goneSeen.push(signal.kind));
    gone.set(null);
    should(goneSeen).deepEqual(['working', 'ended']);
  });

  it('remembers a turn that finished while the send was still being acknowledged', () => {
    // The watch is ARMED before the message goes; working → your-turn happens inside the send's await.
    const fake = source(snap('your-turn', 't1'));
    const watch = sessionReplyFeed(fake.api).arm();
    const seen: ReplySignal['kind'][] = [];
    fake.set(snap('working', 't2'));
    fake.set(snap('your-turn', 't3'));
    should(seen).deepEqual([]);
    // The send is acknowledged: the finished turn is reported at once, not lost.
    watch.attach(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['done']);
  });

  it('remembers a finished turn even when only the time of the state moved before the ack', () => {
    const fake = source(snap('your-turn', 't1'));
    const watch = sessionReplyFeed(fake.api).arm();
    fake.set(snap('your-turn', 't2'));
    const seen: ReplySignal['kind'][] = [];
    watch.attach(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['done']);
  });

  it('still ignores a stale your-turn that never moved before the ack', () => {
    const fake = source(snap('your-turn', 't1'));
    const watch = sessionReplyFeed(fake.api).arm();
    const seen: ReplySignal['kind'][] = [];
    watch.attach(signal => void seen.push(signal.kind));
    should(seen).deepEqual([]);
  });

  it('a cancelled watch stops listening and never reports, before or after the ack', () => {
    const fake = source(snap('working', 't1'));
    const watch = sessionReplyFeed(fake.api).arm();
    should(fake.listeners.size).equal(1);
    watch.cancel();
    watch.cancel();
    should(fake.listeners.size).equal(0);
    const seen: ReplySignal['kind'][] = [];
    fake.set(snap('your-turn', 't2'));
    should(seen).deepEqual([]);
    const attached = sessionReplyFeed(fake.api).arm();
    const stop = attached.attach(signal => void seen.push(signal.kind));
    fake.set(snap('working', 't3'));
    stop();
    fake.set(snap('your-turn', 't4'));
    should(seen).deepEqual(['working']);
  });

  it('ends at once when the session is already finished or missing at the send', () => {
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(source(null).api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    sessionReplyFeed(source(snap('working', 't1', 'failed')).api)
      .arm()
      .attach(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['ended', 'ended']);
  });
});

describe('gatedWakeLock: the "Keep screen on" switch', () => {
  const inner = () => {
    const calls: string[] = [];
    return {
      calls,
      port: {
        acquire: async () => {
          calls.push('acquire');
          return false;
        },
        release: () => void calls.push('release'),
      },
    };
  };

  it('asks the browser when the switch is on, and passes its answer through', async () => {
    const fake = inner();
    const lock = gatedWakeLock(fake.port, () => true);
    should(await lock.acquire()).be.false();
    should(fake.calls).deepEqual(['acquire']);
  });

  it('does not ask when the switch is off, and says "fine" so no screen-may-turn-off warning is shown', async () => {
    const fake = inner();
    const lock = gatedWakeLock(fake.port, () => false);
    should(await lock.acquire()).be.true();
    should(fake.calls).deepEqual([]);
  });

  it('reads the switch at each acquire (a change applies the next time), and always releases', async () => {
    const fake = inner();
    let on = false;
    const lock = gatedWakeLock(fake.port, () => on);
    await lock.acquire();
    on = true;
    await lock.acquire();
    lock.release();
    should(fake.calls).deepEqual(['acquire', 'release']);
  });
});
