/**
 * The Kernel-owned J rows of docs/design/rebuild-parity.tsv that 5.0's kernel really hosts, each named by its id:
 * the housekeeping lane's opening (J-0186), the configuration watcher's interval, backstop and debounce
 * (J-0109, J-0146, J-0265, J-0266), the host arming the configuration load and watcher at boot (J-0066), and the
 * spawn deadline that kills a child (J-0172, today's git runner deadline, which 5.0 hands to the kernel's spawn).
 * Time is driven by hand; the one real child is killed at its deadline (how fast: `tests/perf/parity/jobs.test.ts`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { milliseconds } from '@ferretry/std';
import { AdmissionPort } from '../../../contract/bound.ts';
import type { Cancel, WorkerHandle, WorkersPort } from '../../../contract/ports.ts';
import type { ConfigTreeEvents } from '../../../host/config/watcher.ts';
import {
  CONFIG_WATCH_BACKSTOP_MS,
  CONFIG_WATCH_DEBOUNCE_MS,
  CONFIG_WATCH_INTERVAL_MS,
} from '../../../host/config/watcher.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { systemClock } from '../../../host/adapters/clock.ts';
import { nodeTempDirs } from '../../../host/adapters/temp-dir.ts';
import { bunSpawn, bunWorkers } from '../../../host/adapters/process.ts';
import { runPluginChecks } from '../../../host/check-plugins.ts';
import { DEFAULT_BACKGROUND_DELAY_MS, JobRunner, parseBackgroundDelay } from '../../../host/jobs.ts';
import { fileLogSink, realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, type DaemonImplementation } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { configHarness, updatesDef } from '../host-config/support.ts';
import { recordingAdmission, silentLog } from '../host/fixtures.ts';

/** Lets every promise chain already started run to its end. */
const flush = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) await new Promise(resolve => setImmediate(resolve));
};

describe('the housekeeping lane', () => {
  test.each([
    { name: 'by default two minutes', raw: undefined, delay: 120_000 },
    { name: 'FYD_BACKGROUND_DELAY_SECONDS=7 seven seconds', raw: '7', delay: 7_000 },
  ])('J-0186 the lane opens $name after the daemon serves, and housekeeping waits for it', async ({ raw, delay }) => {
    expect(parseBackgroundDelay(raw)).toBe(delay);
    if (raw === undefined) expect(DEFAULT_BACKGROUND_DELAY_MS).toBe(120_000);
    const clock = fixedClock();
    const ran: string[] = [];
    const runner = new JobRunner(clock, silentLog, () => true, { backgroundDelayMs: parseBackgroundDelay(raw) });
    runner.portFor('usage').add({
      id: 'ingest',
      lane: 'worker',
      schedule: { every: milliseconds(60 * 60_000) },
      run: async () => {
        ran.push('ingest');
      },
    });
    runner.start();
    await flush();
    expect(ran).toEqual([]);
    expect(runner.laneWaiting()).toEqual(['usage/ingest']);
    await clock.advance(delay - 1);
    await flush();
    expect(ran).toEqual([]);
    await clock.advance(1);
    await flush();
    expect(ran).toEqual(['ingest']);
    expect(runner.laneWaiting()).toEqual([]);
    await runner.stop();
  });

  test('J-0186 FYD_BACKGROUND_DELAY_SECONDS=0 opens the lane as soon as the daemon serves', async () => {
    const clock = fixedClock();
    const ran: string[] = [];
    const runner = new JobRunner(clock, silentLog, () => true, { backgroundDelayMs: parseBackgroundDelay('0') });
    runner.portFor('usage').add({
      id: 'ingest',
      lane: 'worker',
      schedule: { onceAfterStart: true },
      run: async () => {
        ran.push('ingest');
      },
    });
    runner.start();
    await flush();
    await clock.advance(0);
    await flush();
    expect(ran).toEqual(['ingest']);
    await runner.stop();
  });

  test('J-0186 a delay that is not whole seconds is refused naming the variable', () => {
    expect(() => parseBackgroundDelay('1.5')).toThrow('FYD_BACKGROUND_DELAY_SECONDS');
  });
});

/** The harness's clock, recording every interval and delay the watcher asks it for. */
function recordedClock(h: ReturnType<typeof configHarness>) {
  const intervals: number[] = [];
  const delays: number[] = [];
  const every = h.clock.every.bind(h.clock);
  const after = h.clock.after.bind(h.clock);
  h.clock.every = (interval, fn): Cancel => {
    intervals.push(interval);
    return every(interval, fn);
  };
  h.clock.after = (delay, fn): Cancel => {
    delays.push(delay);
    return after(delay, fn);
  };
  return { intervals, delays };
}

const limitOf = (h: ReturnType<typeof configHarness>): number | undefined =>
  (h.files.port('updates').file(updatesDef) as { limit: number } | undefined)?.limit;

/** A tree whose directories report events by hand. */
function fakeTree(directory: string) {
  const listeners = new Map<string, () => void>();
  const events: ConfigTreeEvents = {
    directories: async () => [directory],
    subscribeDirectory: (path, listener) => {
      listeners.set(path, listener);
      return { close: () => void listeners.delete(path) };
    },
  };
  return { events, listeners };
}

describe('the configuration watcher', () => {
  test('J-0109 J-0265 without file events the tree is looked at every second, and a tick loads what moved', async () => {
    expect(CONFIG_WATCH_INTERVAL_MS).toBe(1_000);
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const seen = recordedClock(h);
    const stop = h.files.startWatching();
    await flush();
    expect(seen.intervals).toEqual([CONFIG_WATCH_INTERVAL_MS]);
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    h.clock.advance(CONFIG_WATCH_INTERVAL_MS);
    await flush();
    h.clock.advance(CONFIG_WATCH_DEBOUNCE_MS);
    await flush();
    expect(limitOf(h)).toBe(4);
    stop();
  });

  test('J-0109 J-0265 with file events the interval is a thirty-second backstop, and an event does the looking', async () => {
    expect(CONFIG_WATCH_BACKSTOP_MS).toBe(30_000);
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const seen = recordedClock(h);
    const tree = fakeTree(h.path('').replace(/\/$/u, ''));
    const stop = h.files.startWatching(tree.events);
    await flush();
    expect(seen.intervals).toEqual([CONFIG_WATCH_BACKSTOP_MS]);
    expect([...tree.listeners.keys()]).toContain(h.path('').replace(/\/$/u, ''));
    h.fs.seed(h.path('updates.yaml'), 'limit: 3\n');
    // No interval has elapsed: the directory's event alone makes the watcher look.
    for (const listener of tree.listeners.values()) listener();
    await flush();
    h.clock.advance(CONFIG_WATCH_DEBOUNCE_MS);
    await flush();
    expect(limitOf(h)).toBe(3);
    stop();
    expect(tree.listeners.size).toBe(0);
  });

  test('J-0146 J-0266 a change loads only once the tree has been quiet for 300 ms', async () => {
    expect(CONFIG_WATCH_DEBOUNCE_MS).toBe(300);
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const seen = recordedClock(h);
    const stop = h.files.startWatching();
    await flush();
    h.fs.seed(h.path('updates.yaml'), 'limit: 4\n');
    h.clock.advance(CONFIG_WATCH_INTERVAL_MS);
    await flush();
    expect(seen.delays).toEqual([CONFIG_WATCH_DEBOUNCE_MS]);
    h.clock.advance(CONFIG_WATCH_DEBOUNCE_MS - 1);
    await flush();
    expect(limitOf(h)).toBe(5);
    h.clock.advance(1);
    await flush();
    expect(limitOf(h)).toBe(4);
    stop();
  });
});

const roots: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('the host arms the configuration', () => {
  test('J-0066 boot loads the configuration, then watches it, and stopping the daemon stops the watcher', async () => {
    const root = await mkdtemp(`${tmpdir()}/parity-jobs-`);
    roots.push(root);
    const home = `${root}/home`;
    const trace: string[] = [];
    const real = realAdapters(home, () => {}, { binary: 'fy' });
    const adapters: HostOptions['adapters'] = {
      ...real,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => undefined }),
      config: (declarations, judge) => {
        const service = real.config(declarations, judge);
        return {
          ...service,
          reload: async () => {
            trace.push('load');
            await service.reload();
          },
          startWatching: () => {
            trace.push('watch:start');
            return () => void trace.push('watch:stop');
          },
        };
      },
    };
    const gate = definePlugin({
      version: '5.0.0',
      api: 5,
      kinds: [],
      id: 'gate',
      title: 'Gate',
      core: true,
      provides: { admission: AdmissionPort },
    });
    const result = await bootHost({
      home,
      version: '5.0.0',
      implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
      adapters,
    });
    if (result.kind !== 'running') throw new Error(result.sentence);
    hosts.push(result.host);
    expect(trace.slice(0, 2)).toEqual(['load', 'watch:start']);
    expect(trace).not.toContain('watch:stop');
    await result.host.stop();
    expect(trace.at(-1)).toBe('watch:stop');
  });

  test('J-0066 boot publishes the editors’ schemas, config/.schema/<claim>.json, once the configuration is loaded', async () => {
    const root = await mkdtemp(`${tmpdir()}/parity-schemas-`);
    roots.push(root);
    const home = `${root}/home`;
    const trace: string[] = [];
    const real = realAdapters(home, () => {}, { binary: 'fy' });
    const adapters: HostOptions['adapters'] = {
      ...real,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => undefined }),
      config: (declarations, judge) => {
        const service = real.config(declarations, judge);
        return {
          ...service,
          reload: async () => {
            trace.push('load');
            await service.reload();
          },
          publishSchemas: async () => {
            trace.push('publish');
            await service.publishSchemas?.();
          },
        };
      },
    };
    const gate = definePlugin({
      version: '5.0.0',
      api: 5,
      kinds: [],
      id: 'gate',
      title: 'Gate',
      core: true,
      provides: { admission: AdmissionPort },
    });
    const result = await bootHost({
      home,
      version: '5.0.0',
      implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
      adapters,
    });
    if (result.kind !== 'running') throw new Error(result.sentence);
    hosts.push(result.host);
    expect(trace.slice(0, 2)).toEqual(['load', 'publish']);
    const written = await readdir(`${home}/config/.schema`);
    expect(written.length).toBeGreaterThan(0);
    for (const name of written) expect(name).toMatch(/\.json$/u);
  });

  test('J-0066 a schema that cannot be written does not stop the daemon from serving', async () => {
    const root = await mkdtemp(`${tmpdir()}/parity-schemas-`);
    roots.push(root);
    const home = `${root}/home`;
    const trace: string[] = [];
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const real = realAdapters(
      home,
      record => {
        if (record.level === 'warn') warnings.push(record);
      },
      { binary: 'fy' },
    );
    const adapters: HostOptions['adapters'] = {
      ...real,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => undefined }),
      config: (declarations, judge) => {
        const service = real.config(declarations, judge);
        return {
          ...service,
          reload: async () => {
            trace.push('load');
            await service.reload();
          },
          publishSchemas: async () => {
            trace.push('publish');
            throw new Error('read-only');
          },
        };
      },
    };
    const gate = definePlugin({
      version: '5.0.0',
      api: 5,
      kinds: [],
      id: 'gate',
      title: 'Gate',
      core: true,
      provides: { admission: AdmissionPort },
    });
    const result = await bootHost({
      home,
      version: '5.0.0',
      implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
      adapters,
    });
    if (result.kind !== 'running') throw new Error(result.sentence);
    hosts.push(result.host);
    expect(trace.slice(0, 2)).toEqual(['load', 'publish']);
    expect(result.host).toBeDefined();
    // The daemon serves, and the warning says why the schemas were not written.
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'the configuration schemas could not be written',
        fields: { reason: 'read-only' },
      }),
    );
  });
});

describe('the spawn deadline', () => {
  test('J-0172 a child still running at its deadline is killed with SIGKILL and the answer says it timed out', async () => {
    const spawn = bunSpawn({ PATH: process.env.PATH ?? '' });
    // The child ignores SIGTERM and says who it is, so only SIGKILL can have ended it.
    const answer = await spawn.runBytes(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1_000);",
      ],
      // Long enough for a fresh `bun -e` to start and write its pid on a loaded runner; the speed bound is the perf tier's.
      { timeout: milliseconds(2_000) },
    );
    expect(answer.timedOut).toBe(true);
    expect(answer.exitCode).toBe(-1);
    const pid = Number(new TextDecoder().decode(answer.stdout));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let wait = 0; wait < 40 && alive(); wait += 1) await new Promise(resolve => setTimeout(resolve, 50));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
  });

  test('J-0172 a child that finishes inside its deadline is not marked timed out', async () => {
    const spawn = bunSpawn({ PATH: process.env.PATH ?? '' });
    const answer = await spawn.runBytes(process.execPath, ['-e', 'process.stdout.write("done")'], {
      timeout: milliseconds(20_000),
    });
    expect(answer.timedOut).toBe(false);
    expect(answer.exitCode).toBe(0);
    expect(new TextDecoder().decode(answer.stdout)).toBe('done');
  });
});

describe('the runtime timers the kernel replaced', () => {
  test('J-0093 J-0175 clock.after runs its callback once, as handed over, when due; cancelled it never runs (no activity ledger)', async () => {
    const clock = fixedClock();
    const ran: string[] = [];
    const cancel = clock.after(milliseconds(50), () => void ran.push('due'));
    const cancelled = clock.after(milliseconds(50), () => void ran.push('cancelled'));
    cancelled();
    await clock.advance(49);
    expect(ran).toEqual([]);
    await clock.advance(1);
    await clock.advance(500);
    expect(ran).toEqual(['due']);
    cancel();
    // The real clock is the same timer: it fires once, and a cancelled one stays quiet.
    const real = systemClock();
    const fired: string[] = [];
    real.after(milliseconds(5), () => void fired.push('fired'));
    real.after(milliseconds(5), () => void fired.push('cancelled'))();
    await real.sleep(milliseconds(60));
    expect(fired).toEqual(['fired']);
  });

  test('J-0153 a log record is one JSON line appended at once and in call order: nothing is queued, so nothing is drained or late', () => {
    const lines: string[] = [];
    const sink = fileLogSink(line => void lines.push(line));
    for (const message of ['one', 'two', 'three']) sink({ level: 'info', scope: 'kernel', message });
    // Every line is out before the call returns: there is no writer to wait for.
    expect(lines).toHaveLength(3);
    expect(lines.every(line => line.endsWith('\n'))).toBe(true);
    expect(lines.map(line => (JSON.parse(line) as { message: string }).message)).toEqual(['one', 'two', 'three']);
  });

  test('J-0165 a worker that never answers the probe is reported once the kernel deadline passes, and is terminated', async () => {
    const clock = fixedClock();
    const terminated: string[] = [];
    const workers: WorkersPort = {
      start: (url): WorkerHandle => ({
        post: () => {},
        onMessage: () => () => {},
        onExit: () => () => {},
        terminate: async () => void terminated.push(url.href),
      }),
    };
    const manifest = definePlugin({
      id: 'w',
      title: 'w',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      workers: ['housekeeping'],
    });
    const implementation = {
      half: 'daemon',
      manifest,
      build: () => ({}),
      workers: { housekeeping: new URL('file:///h.ts') },
    } as unknown as DaemonImplementation;
    const said: string[] = [];
    const done = runPluginChecks(
      {
        implementations: [implementation],
        facts: { home: '/h', host: '127.0.0.1', port: 9123, version: '5.0.0', platform: 'linux', arch: 'x64' },
        workers,
        tempDirs: nodeTempDirs('/not-the-state-home'),
        clock,
        workerTimeoutMs: 1_000,
      },
      line => void said.push(line),
    );
    await flush();
    await clock.advance(999);
    await flush();
    expect(said).toEqual([]);
    await clock.advance(1);
    await done;
    expect(said).toEqual(['workers      ! housekeeping did not start — no answer within 1000 ms.']);
    expect(terminated).toEqual(['file:///h.ts']);
  });
});

describe('the worker thread the kernel starts', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real worker that answers `{ id }` after `delay` ms, started the way a plugin's worker is. */
  async function start() {
    const dir = await mkdtemp(`${tmpdir()}/fy-worker-`);
    dirs.push(dir);
    const file = `${dir}/late.worker.ts`;
    await writeFile(
      file,
      'self.onmessage = e => { setTimeout(() => postMessage({ id: e.data.id }), e.data.delay); };\n',
    );
    const handle = bunWorkers().start(pathToFileURL(file), { name: 'late' });
    const answers: number[] = [];
    const exits: number[] = [];
    handle.onMessage(message => void answers.push((message as { id: number }).id));
    handle.onExit(exit => void exits.push(exit.code));
    const until = async (done: () => boolean): Promise<void> => {
      for (let wait = 0; wait < 100 && !done(); wait += 1) await new Promise(resolve => setTimeout(resolve, 20));
    };
    return { handle, answers, exits, until };
  }

  test('J-0161 an idle worker is not ended by the kernel: it stays up and answers later, and only terminate ends it', async () => {
    const worker = await start();
    worker.handle.post({ id: 1, delay: 0 });
    await worker.until(() => worker.answers.length === 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(worker.exits).toEqual([]);
    worker.handle.post({ id: 2, delay: 0 });
    await worker.until(() => worker.answers.length === 2);
    expect(worker.answers).toEqual([1, 2]);
    await worker.handle.terminate();
    await worker.until(() => worker.exits.length > 0);
    expect(worker.exits).toHaveLength(1);
  });

  test('J-0169 a slow request is not failed by the kernel: no per-request deadline, the answer arrives whenever the plugin sends it', async () => {
    const worker = await start();
    worker.handle.post({ id: 7, delay: 300 });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(worker.answers).toEqual([]);
    expect(worker.exits).toEqual([]);
    await worker.until(() => worker.answers.length === 1);
    expect(worker.answers).toEqual([7]);
    expect(worker.exits).toEqual([]);
    await worker.handle.terminate();
  });
});
