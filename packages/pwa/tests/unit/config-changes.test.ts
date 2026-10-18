import { describe, expect, it } from 'bun:test';
import { CONFIG_CHANGE_KINDS, type ConfigChangeFrame, type ConfigChangeKind } from '@ferretry/protocol';
import {
  CONFIG_STREAM_BACKOFF,
  CONFIG_STREAM_SILENCE_MS,
  configStreamDelayMs,
  DaemonConfigChangeStore,
  kindsToReread,
  startConfigChangeStream,
} from '../../src/lib/config-changes.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const STUDIO = 'studio' as DaemonId;
const LAPTOP = 'laptop' as DaemonId;

const config = (revision: number, kinds: ConfigChangeKind[] = [], epoch = 'boot-1'): ConfigChangeFrame => ({
  kind: 'config',
  epoch,
  revision,
  kinds,
});

const idle = (revision: number, epoch = 'boot-1'): ConfigChangeFrame => ({
  kind: 'idle',
  epoch,
  revision,
  idleSeconds: 30,
});

describe('kindsToReread', () => {
  it('reads nothing again for the first frame of a fresh browser, which is the baseline', () => {
    expect(kindsToReread(null, config(4))).toEqual([]);
    // A first frame that already names a change still names what moved.
    expect(kindsToReread(null, config(5, ['runtimes']))).toEqual(['runtimes']);
  });

  it('reads exactly what the next revision says moved', () => {
    expect(kindsToReread({ epoch: 'boot-1', revision: 2 }, config(3, ['credentials', 'runtimes']))).toEqual([
      'credentials',
      'runtimes',
    ]);
  });

  it('reads everything again after a revision it never heard about, or a new boot', () => {
    // Reconnected: the first frame says the revision moved while the stream was down.
    expect(kindsToReread({ epoch: 'boot-1', revision: 2 }, config(5))).toEqual(CONFIG_CHANGE_KINDS);
    // A frame that skipped a revision.
    expect(kindsToReread({ epoch: 'boot-1', revision: 2 }, config(4, ['warden']))).toEqual(CONFIG_CHANGE_KINDS);
    // The daemon restarted: its revision 1 is not the old boot's.
    expect(kindsToReread({ epoch: 'boot-1', revision: 9 }, config(1, [], 'boot-2'))).toEqual(CONFIG_CHANGE_KINDS);
    // An idle proof that says the revision moved.
    expect(kindsToReread({ epoch: 'boot-1', revision: 2 }, idle(3))).toEqual(CONFIG_CHANGE_KINDS);
  });

  it('reads nothing for a revision already seen', () => {
    expect(kindsToReread({ epoch: 'boot-1', revision: 3 }, config(3))).toEqual([]);
    expect(kindsToReread({ epoch: 'boot-1', revision: 3 }, idle(3))).toEqual([]);
    expect(kindsToReread({ epoch: 'boot-1', revision: 3 }, config(2, ['voice']))).toEqual([]);
  });
});

describe('DaemonConfigChangeStore', () => {
  it('moves the counters of the kinds a change named, on that machine only', () => {
    const store = new DaemonConfigChangeStore();
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    store.observe(STUDIO, config(0));
    store.observe(LAPTOP, config(0));

    store.observe(STUDIO, config(1, ['runtimes']));

    expect(store.counter(STUDIO, ['runtimes'])).toBe(1);
    expect(store.counter(STUDIO, ['credentials', 'runtimes'])).toBe(1);
    expect(store.counter(STUDIO, ['warden'])).toBe(0);
    expect(store.counter(LAPTOP, ['runtimes'])).toBe(0);
    expect(told).toBe(1);
  });

  it('moves every counter when a reconnect finds the revision moved', () => {
    const store = new DaemonConfigChangeStore();
    store.observe(STUDIO, config(2));

    store.observe(STUDIO, config(7));

    for (const kind of CONFIG_CHANGE_KINDS) expect(store.counter(STUDIO, [kind])).toBe(1);
  });

  it('tells nobody about a frame that changes nothing', () => {
    const store = new DaemonConfigChangeStore();
    store.observe(STUDIO, config(2));
    let told = 0;
    const leave = store.subscribe(() => {
      told += 1;
    });

    store.observe(STUDIO, idle(2));
    store.observe(STUDIO, config(1, ['runtimes']));
    leave();
    store.observe(STUDIO, config(3, ['runtimes']));

    expect(told).toBe(0);
    expect(store.counter(STUDIO, ['runtimes'])).toBe(1);
  });

  it('answers zero for a machine it has heard nothing from', () => {
    expect(new DaemonConfigChangeStore().counter(STUDIO, CONFIG_CHANGE_KINDS)).toBe(0);
  });
});

/** A configuration stream a test drives: every open is recorded, and each one ends when told. */
class FakeStream {
  readonly opens: {
    readonly onFrame: (frame: ConfigChangeFrame) => void;
    readonly signal: AbortSignal | undefined;
    end(error?: Error): void;
  }[] = [];

  configChanges(onFrame: (frame: ConfigChangeFrame) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.opens.push({ onFrame, signal, end: error => (error === undefined ? resolve() : reject(error)) });
    });
  }
}

class Timers {
  readonly armed: { readonly milliseconds: number; readonly callback: () => void; cleared: boolean }[] = [];
  setTimeout = (callback: () => void, milliseconds: number): unknown => {
    const entry = { milliseconds, callback, cleared: false };
    this.armed.push(entry);
    return entry;
  };
  clearTimeout = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };
  random = (): number => 1;
  /** The live timers of one length. */
  live(milliseconds: number) {
    return this.armed.filter(entry => !entry.cleared && entry.milliseconds === milliseconds);
  }
  fire(milliseconds: number): void {
    for (const entry of this.live(milliseconds)) {
      entry.cleared = true;
      entry.callback();
    }
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('startConfigChangeStream', () => {
  it('hands every frame on, and reopens a dropped stream after a growing delay', async () => {
    const api = new FakeStream();
    const timers = new Timers();
    const frames: ConfigChangeFrame[] = [];
    startConfigChangeStream({ api, environment: timers, onFrame: frame => frames.push(frame) });
    api.opens[0]?.onFrame(config(0));

    api.opens[0]?.end(new Error('dropped'));
    await flush();
    timers.fire(CONFIG_STREAM_BACKOFF.baseMs);
    api.opens[1]?.end();
    await flush();
    timers.fire(CONFIG_STREAM_BACKOFF.baseMs * 2);

    expect(frames).toEqual([config(0)]);
    expect(api.opens).toHaveLength(3);
  });

  it('treats a silent stream as dropped, and cancels it', async () => {
    const api = new FakeStream();
    const timers = new Timers();
    startConfigChangeStream({ api, environment: timers, onFrame: () => undefined });

    timers.fire(CONFIG_STREAM_SILENCE_MS);
    api.opens[0]?.end();
    await flush();
    timers.fire(CONFIG_STREAM_BACKOFF.baseMs);

    expect(api.opens[0]?.signal?.aborted).toBe(true);
    // The cancelled attempt settling afterwards schedules nothing of its own.
    expect(api.opens).toHaveLength(2);
  });

  it('reopens at once on reconnect, and resets the delay', async () => {
    const api = new FakeStream();
    const timers = new Timers();
    const control = startConfigChangeStream({ api, environment: timers, onFrame: () => undefined });
    api.opens[0]?.end();
    await flush();

    control.reconnect();
    api.opens[1]?.end();
    await flush();

    expect(api.opens).toHaveLength(2);
    expect(timers.live(CONFIG_STREAM_BACKOFF.baseMs)).toHaveLength(1);
  });

  it('opens nothing and hands nothing on once stopped', async () => {
    const api = new FakeStream();
    const timers = new Timers();
    const frames: ConfigChangeFrame[] = [];
    const control = startConfigChangeStream({ api, environment: timers, onFrame: frame => frames.push(frame) });
    api.opens[0]?.end();
    await flush();

    control.stop();
    control.stop();
    control.reconnect();
    api.opens[0]?.onFrame(config(1));

    expect(timers.armed.every(entry => entry.cleared)).toBe(true);
    expect(api.opens).toHaveLength(1);
    expect(frames).toEqual([]);
  });

  it('ignores a frame from an attempt that was replaced', () => {
    const api = new FakeStream();
    const timers = new Timers();
    const frames: ConfigChangeFrame[] = [];
    const control = startConfigChangeStream({ api, environment: timers, onFrame: frame => frames.push(frame) });

    control.reconnect();
    api.opens[0]?.onFrame(config(1));
    api.opens[1]?.onFrame(config(2));

    expect(frames).toEqual([config(2)]);
  });
});

describe('configStreamDelayMs', () => {
  it('grows from half the base window to the ceiling, jittered inside each window', () => {
    expect(configStreamDelayMs(0, 0)).toBe(500);
    expect(configStreamDelayMs(0, 1)).toBe(1_000);
    expect(configStreamDelayMs(3, 1)).toBe(8_000);
    expect(configStreamDelayMs(20, 1)).toBe(CONFIG_STREAM_BACKOFF.ceilingMs);
    expect(configStreamDelayMs(-4, 2)).toBe(1_000);
  });
});
