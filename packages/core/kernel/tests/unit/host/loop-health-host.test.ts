/** J-0039 J-0085 R-0036: the host ticks the loop meter from the start of boot, feeds the watchdog, and stops both with the host. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AdmissionPort } from '../../../contract/bound.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import type { IoPressure, IoPressureSource, LoopWatchdogPort } from '../../../host/loop-health.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request, silentLog } from './fixtures.ts';

const parents: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const base = { version: '5.0.0', api: 5, core: false, kinds: [] } as const;
const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});

/** The watchdog and the disk reading as recorders, and a clock whose `nowMs` runs ahead by what the test "blocks". */
function rig() {
  const fixed = fixedClock();
  const blocked = { ms: 0 };
  const clock = { ...fixed, nowMs: () => fixed.nowMs() + blocked.ms };
  const beats: (readonly string[])[] = [];
  const stopped = { watchdog: 0, io: 0 };
  const reading: { current: IoPressure | undefined } = { current: undefined };
  const watchdog: LoopWatchdogPort = {
    beat: during => beats.push(during),
    stop: () => {
      stopped.watchdog += 1;
    },
  };
  const ioPressure: IoPressureSource = {
    current: () => reading.current,
    start: () => () => {
      stopped.io += 1;
    },
  };
  return { fixed, clock, blocked, beats, stopped, reading, watchdog, ioPressure };
}

async function boot(setup: ReturnType<typeof rig>, implementations: HostOptions['implementations']) {
  const parent = await mkdtemp(`${tmpdir()}/loop-health-host-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const adapters: HostOptions['adapters'] = {
    ...realAdapters(home, () => {}, { binary: 'fy' }),
    clock: setup.clock,
    homeLock: async () => ({ release: async () => {} }),
    state: stateOpener(home, createMemoryHostFs(), setup.clock, silentLog),
    loopHealth: { ioPressure: setup.ioPressure, watchdog: () => setup.watchdog },
  };
  return await bootHost({ home, version: '5.0.0', pid: 11, implementations, adapters });
}

const admission = implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) });

test('the watchdog is fed the boot step while the daemon starts, and nothing once it serves', async () => {
  const setup = rig();
  const slow = implementDaemon(definePlugin({ ...base, id: 'slow', title: 'Slow' }), {
    // A step that lets a quarter second pass: the tick fires while the boot is on it.
    build: () => ({
      beforeListen: async () => {
        await setup.fixed.advance(250);
      },
    }),
  });
  const outcome = await boot(setup, [admission, slow]);
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  expect(setup.beats).toEqual([['boot: beforeListen:slow']]);
  await setup.fixed.advance(250);
  expect(setup.beats).toEqual([['boot: beforeListen:slow'], []]);
});

test('J-0039 a blocked loop is counted and told on /healthz, with the disk when it was saturated', async () => {
  const setup = rig();
  const outcome = await boot(setup, [admission]);
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  setup.reading.current = { some: { avg10: 50, avg60: 1, avg300: 1 }, full: { avg10: 20, avg60: 1, avg300: 1 } };
  // The loop was "blocked" for 700 ms: the next tick fires 700 ms late.
  setup.blocked.ms += 700;
  await setup.fixed.advance(250);
  const answer = JSON.parse((await outcome.host.dispatch(request('GET', '/healthz', { local: true }))).body);
  expect(answer.eventLoop).toMatchObject({
    lagMs: 700,
    maxLagMs: 700,
    stalls: 1,
    lastStall: { durationMs: 700, cause: 'disk' },
    io: { someAvg10: 50, fullAvg10: 20, saturated: true },
  });
});

test('J-0085 the meter, the disk reader and the watchdog stop with the host, and the ticks stop', async () => {
  const setup = rig();
  const outcome = await boot(setup, [admission]);
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  await outcome.host.stop();
  expect(setup.stopped).toEqual({ watchdog: 1, io: 1 });
  const beats = setup.beats.length;
  await setup.fixed.advance(1_000);
  expect(setup.beats).toHaveLength(beats);
});

test('J-0085 a boot that ends refused stops them too', async () => {
  const setup = rig();
  const broken = implementDaemon(definePlugin({ ...base, id: 'mailbox', title: 'Mailbox', core: true }), {
    build: () => {
      throw new Error('cannot build');
    },
  });
  const outcome = await boot(setup, [admission, broken]);
  expect(outcome.kind).toBe('refused');
  expect(setup.stopped).toEqual({ watchdog: 1, io: 1 });
});

async function bootBare(setup: ReturnType<typeof rig>, loopHealth: HostOptions['adapters']['loopHealth']) {
  const parent = await mkdtemp(`${tmpdir()}/loop-health-host-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [admission],
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: setup.clock,
      homeLock: async () => ({ release: async () => {} }),
      state: stateOpener(home, createMemoryHostFs(), setup.clock, silentLog),
      ...(loopHealth === undefined ? {} : { loopHealth }),
    },
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  return outcome.host;
}

test('a host with no disk reader and no watchdog still measures the loop', async () => {
  const setup = rig();
  const host = await bootBare(setup, {});
  setup.blocked.ms += 400;
  await setup.fixed.advance(250);
  const answer = JSON.parse((await host.dispatch(request('GET', '/healthz', { local: true }))).body);
  expect(answer.eventLoop).toMatchObject({ lagMs: 400, stalls: 1 });
  expect(answer.eventLoop).not.toHaveProperty('io');
});

test('a host whose composition root did not ask for loop health arms no tick: a driven clock has no extra timer', async () => {
  const withNone = rig();
  const bare = await bootBare(withNone, undefined);
  const timers = withNone.fixed.pending();
  withNone.blocked.ms += 700;
  await withNone.fixed.advance(250);
  const answer = JSON.parse((await bare.dispatch(request('GET', '/healthz', { local: true }))).body);
  expect(answer.eventLoop).toEqual({ lagMs: 0, maxLagMs: 0, stalls: 0 });
  const looking = rig();
  await bootBare(looking, {});
  expect(looking.fixed.pending()).toBe(timers + 1);
});

test('J-0039 a plugin with no permission reads kernel.loop.blockedMs(): the meter total, monotone, 0 without a tick', async () => {
  let blockedMs: (() => number) | undefined;
  const reader = implementDaemon(definePlugin({ ...base, id: 'reader', title: 'Reader' }), {
    build: ctx => {
      blockedMs = ctx.kernel.loop.blockedMs;
      return {};
    },
  });
  const ticking = rig();
  const outcome = await boot(ticking, [admission, reader]);
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  const read = blockedMs as () => number;
  expect(read()).toBe(0);
  ticking.blocked.ms += 700;
  // Counted at once, through now (less the quarter second a tick is due): the late tick has not fired yet.
  expect(read()).toBe(450);
  await ticking.fixed.advance(250);
  expect(read()).toBe(700);
  ticking.blocked.ms += 100;
  await ticking.fixed.advance(250);
  expect(read()).toBe(800);

  // No loop health on this host: the meter is never ticked, so it reports no blocking rather than uptime.
  const bare = rig();
  const parent = await mkdtemp(`${tmpdir()}/loop-health-host-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const quiet = await bootHost({
    home,
    version: '5.0.0',
    implementations: [admission, reader],
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: bare.clock,
      homeLock: async () => ({ release: async () => {} }),
      state: stateOpener(home, createMemoryHostFs(), bare.clock, silentLog),
    },
  });
  if (quiet.kind !== 'running') throw new Error(quiet.sentence);
  hosts.push(quiet.host);
  bare.blocked.ms += 5_000;
  expect((blockedMs as () => number)()).toBe(0);
});
