/**
 * Proves the small browser adapters of Live voice against plain-object fakes of the page:
 * the clock, the visibility of the document, the one-Live-tab lock, the screen wake lock, the level
 * frames read from a meter-only stream, and the reply feed read from the session view.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { browserClock } from '../../../src/lib/voice-chat/clock.ts';
import { meterLevelFrames } from '../../../src/lib/voice-chat/level-frames.ts';
import { LIVE_LOCK_NAME, webMicLock } from '../../../src/lib/voice-chat/mic-lock.ts';
import type { ClockPort, ReplySignal, VisibilityPort } from '../../../src/lib/voice-chat/ports.ts';
import { type ReplySnapshot, type ReplySource, sessionReplyFeed } from '../../../src/lib/voice-chat/reply-feed.ts';
import { documentVisibility } from '../../../src/lib/voice-chat/visibility.ts';
import { screenWakeLock } from '../../../src/lib/voice-chat/wake-lock.ts';
import type { MicMeterPort } from '../../../src/lib/stt/level-monitor.ts';

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
    clock.after(50, () => void (ran += 1));
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
    void fake.released?.then(() => void (settled = true));
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

  it('grants without the API, and when the browser refuses the request', async () => {
    should(await webMicLock(undefined).acquire()).be.true();
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
    return { port, listeners, emit: (visible: boolean) => listeners.forEach(listener => listener(visible)) };
  };
  const sentinels = () => {
    const made: { released: number }[] = [];
    return {
      made,
      api: {
        request: async () => {
          const sentinel = { released: 0 };
          made.push(sentinel);
          return { release: async () => void (sentinel.released += 1) };
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
    const refused = screenWakeLock({ request: () => Promise.reject(new Error('battery saver')) }, view.port);
    should(await refused.acquire()).be.false();
  });

  it('releases a lock that arrives after release was asked for', async () => {
    const view = visibility();
    let finish: (sentinel: { release(): Promise<void> }) => void = () => undefined;
    const released: number[] = [];
    const lock = screenWakeLock({ request: () => new Promise(resolve => void (finish = resolve)) }, view.port);
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
    const stop = sessionReplyFeed(fake.api).watch(signal => void seen.push(signal.kind));
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
    sessionReplyFeed(fake.api).watch(signal => void seen.push(signal.kind));
    fake.set(snap('your-turn', 't2'));
    should(seen).deepEqual(['done']);
  });

  it('starts from working when the session is already working, and reads a question', () => {
    const fake = source(snap('working', 't1'));
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(fake.api).watch(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['working']);
    fake.set(snap('needs-input', 't2'));
    should(seen).deepEqual(['working', 'needs-input']);
  });

  it('says nothing for a daemon without turnState, and ends when the session finishes or goes', () => {
    const quiet = source(snap(undefined, undefined));
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(quiet.api).watch(signal => void seen.push(signal.kind));
    quiet.set(snap(undefined, undefined));
    should(seen).deepEqual([]);
    quiet.set(snap('your-turn', 't1', 'completed'));
    should(seen).deepEqual(['ended']);
    const gone = source(snap('working', 't1'));
    const goneSeen: ReplySignal['kind'][] = [];
    sessionReplyFeed(gone.api).watch(signal => void goneSeen.push(signal.kind));
    gone.set(null);
    should(goneSeen).deepEqual(['working', 'ended']);
  });

  it('ends at once when the session is already finished or missing at the send', () => {
    const seen: ReplySignal['kind'][] = [];
    sessionReplyFeed(source(null).api).watch(signal => void seen.push(signal.kind));
    sessionReplyFeed(source(snap('working', 't1', 'failed')).api).watch(signal => void seen.push(signal.kind));
    should(seen).deepEqual(['ended', 'ended']);
  });
});
