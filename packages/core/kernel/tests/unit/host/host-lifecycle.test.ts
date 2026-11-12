import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { milliseconds } from '@ferretry/std';
import { z } from 'zod';
import { AdmissionPort, OutputGuardPort, WITHHELD_SENTENCE, type OutputGuard } from '../../../contract/bound.ts';
import { defineEvent, definePort, defineState } from '../../../contract/define.ts';
import { ApiError, jsonResponse } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import { Carriers, SessionModes } from '../../../contract/kernel.ts';
import type { StatePort } from '../../../contract/ports.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { sessionIdFromBytes } from '../../../host/session/index.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route, socket, tool } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { FakeDeviceMode, pairedDevice, settle, TestClient } from '../host-session/harness.ts';
import { recordingAdmission, request, silentLog } from './fixtures.ts';

const roots: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const base = { version: '5.0.0', api: 5, core: false, kinds: [] } as const;
const scope = {
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
} as const;
const Policy = defineState({
  name: 'policy',
  path: 'policy.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ value: z.number() }),
});
const AccessPort = definePort<{ count(): number }>('access-fixture');
const BoardPort = definePort<{ count(): number }>('board-fixture');
const Tick = defineEvent('fixture.tick', z.strictObject({ value: z.number() }));
const gate = definePlugin({ ...base, id: 'gate', title: 'Gate', core: true, provides: { admission: AdmissionPort } });
const gateHalf = () => implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) });

async function world() {
  const root = await mkdtemp(`${tmpdir()}/host-r1b-`);
  roots.push(root);
  const home = `${root}/home`;
  const clock = fixedClock();
  const fs = createMemoryHostFs();
  const trace: string[] = [];
  const real = realAdapters(home, () => {}, { binary: 'fy' });
  const state = stateOpener(home, fs, clock, silentLog);
  const adapters: HostOptions['adapters'] = {
    ...real,
    clock,
    homeLock: async () => ({
      release: async () => {
        trace.push('lock:stop');
      },
    }),
    state: manifest => {
      const handle = state(manifest);
      return {
        ...handle,
        get port() {
          return handle.port;
        },
        open: async () => {
          trace.push(`state:${manifest.id}:open`);
          return handle.open();
        },
        close: async () => {
          trace.push(`state:${manifest.id}:stop`);
          await handle.close();
        },
      };
    },
    config: declarations => {
      const service = real.config(declarations);
      return {
        ...service,
        startWatching: () => {
          trace.push('watch:start');
          return () => {
            trace.push('watch:stop');
          };
        },
      };
    },
  };
  const options: HostOptions = { home, version: '5.0.0', implementations: [], adapters };
  return {
    home,
    fs,
    clock,
    trace,
    options,
    async boot(implementations: HostOptions['implementations'], extra: Partial<HostOptions> = {}) {
      const result = await bootHost({ ...options, implementations, ...extra });
      if (result.kind !== 'running') throw new Error(result.sentence);
      hosts.push(result.host);
      return result.host;
    },
  };
}

function clientFor(host: RunningHost): TestClient {
  const id = sessionIdFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  if (id === null) throw new Error('fixture id');
  return new TestClient(host.sessionLayer.open('relay' as CarrierKey), id);
}

function accessFixture() {
  const mode = new FakeDeviceMode();
  let state: StatePort | undefined;
  let heard = 0;
  let runs = 0;
  let aborted = 0;
  let cachedCount: (() => number) | undefined;
  let boundCount: (() => number) | undefined;
  let streamClosed = 0;
  const access = definePlugin({
    ...base,
    id: 'access',
    title: 'Access',
    provides: { access: AccessPort },
    data: { state: [Policy], subscribes: [Tick] },
    hooks: { takes: [{ hook: SessionModes, key: 'device' }] },
    actions: { routes: [route('GET /v1/access', scope)] },
  });
  const board = definePlugin({
    ...base,
    id: 'board',
    title: 'Board',
    needs: { access: AccessPort },
    provides: { board: BoardPort },
    actions: { routes: [route('GET /v1/board', scope)], sockets: [socket('GET /v1/board/live', scope)] },
  });
  const agenda = definePlugin({ ...base, id: 'agenda', title: 'Agenda', needs: { board: BoardPort } });
  const implementations = [
    gateHalf(),
    implementDaemon(access, {
      build: ctx => {
        state = ctx.kernel.state;
        ctx.kernel.jobs.add({
          id: 'read',
          schedule: { every: milliseconds(10) },
          run: signal => {
            runs++;
            return new Promise<void>(resolve =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted++;
                  resolve();
                },
                { once: true },
              ),
            );
          },
        });
        return {
          provides: { access: { count: () => 1 } },
          hooks: { 'session.modes:device': mode },
          routes: { 'GET /v1/access': async () => jsonResponse({ ok: true }) },
          subscribers: {
            'fixture.tick': () => {
              heard++;
            },
          },
        };
      },
    }),
    implementDaemon(board, {
      build: ctx => {
        cachedCount = ctx.needs.access.count;
        boundCount = ctx.needs.access.count.bind(ctx.needs.access);
        return {
          provides: { board: { count: () => ctx.needs.access.count() } },
          routes: { 'GET /v1/board': async () => jsonResponse({ count: ctx.needs.access.count() }) },
          sockets: {
            'GET /v1/board/live': async () => async () => ({
              open: async () => {},
              fromClient: () => {},
              close: () => {
                streamClosed++;
              },
            }),
          },
        };
      },
    }),
    implementDaemon(agenda, {
      build: ctx => {
        ctx.kernel.jobs.add({
          id: 'dependent',
          schedule: { onceAfterStart: true },
          run: async () => {
            ctx.needs.board.count();
          },
        });
        return {};
      },
    }),
  ];
  return {
    mode,
    implementations,
    state: () => {
      if (!state) throw new Error('not built');
      return state;
    },
    heard: () => heard,
    runs: () => runs,
    aborted: () => aborted,
    count: () => cachedCount?.(),
    boundCount: () => boundCount?.(),
    streamClosed: () => streamClosed,
  };
}

describe('live host ownership (§7.1, §9.3)', () => {
  test('damage while a session proof is in flight ends it before the cached mode can authenticate it', async () => {
    const w = await world();
    const fx = accessFixture();
    const host = await w.boot(fx.implementations);
    const device = await pairedDevice(fx.mode);
    const client = clientFor(host);
    await client.handshake(host.identity.daemonId);
    let release = (): void => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = fx.mode.holder.bind(fx.mode);
    fx.mode.holder = async proof => {
      await held;
      return holder(proof);
    };
    const auth = client.auth(device);
    await settle();
    w.fs.seed(`${w.home}/state/access/policy.json`, '{ broken');
    await fx.state().read(Policy);
    release();
    await auth;
    expect(client.last('authenticated')).toBeUndefined();
    expect(client.end?.code).toBe(4403);
  });

  test('damage stops the owning carrier and its sessions; a verified repair starts a fresh carrier', async () => {
    const w = await world();
    let state: StatePort | undefined;
    const signals: AbortSignal[] = [];
    const connections = definePlugin({
      ...base,
      id: 'connections',
      title: 'Connections',
      data: { state: [Policy] },
      hooks: { takes: [{ hook: Carriers, key: 'relay' }] },
    });
    const host = await w.boot([
      implementDaemon(connections, {
        build: ctx => {
          state = ctx.kernel.state;
          return {
            hooks: {
              'carriers:relay': {
                start: async (_layer, signal) => {
                  signals.push(signal);
                  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
                },
                status: () => ({ state: 'ready', sentence: 'fixture' }),
              },
            },
          };
        },
      }),
    ]);
    host.sessionLayer.open('relay' as CarrierKey);
    expect(signals).toHaveLength(1);
    w.fs.seed(`${w.home}/state/connections/policy.json`, '{ broken');
    await state?.read(Policy);
    expect(signals[0]?.aborted).toBe(true);
    expect(host.sessionLayer.report().sessions).toBe(0);
    w.fs.seed(`${w.home}/state/connections/policy.json`, '{"format":1,"value":1}');
    await state?.read(Policy);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });
  test('boot-damaged Access supplies no modes, required ports, jobs or healthy event subscriptions', async () => {
    const w = await world();
    w.fs.seed(`${w.home}/state/access/policy.json`, '{ broken');
    const fx = accessFixture();
    const host = await w.boot(fx.implementations);
    expect(host.plugins.get('access')?.status).toBe('damaged');
    expect(host.plugins.get('board')?.status).toBe('failed');
    expect(host.plugins.get('agenda')?.status).toBe('failed');
    expect(host.hooks.provider(SessionModes, 'device')).toBe('unavailable');
    host.events.publish(Tick, { value: 1 });
    await w.clock.advance(100);
    await host.jobs.settle();
    expect(fx.heard()).toBe(0);
    expect(fx.runs()).toBe(0);
    const client = clientFor(host);
    await client.handshake(host.identity.daemonId);
    await client.auth(await pairedDevice(fx.mode));
    expect(client.last('authenticated')).toBeUndefined();
    expect(client.end?.code).toBe(4403);
  });

  test('live damage revokes cached providers, dependent routes/jobs, sessions and streams; doctor follows repair', async () => {
    const w = await world();
    const fx = accessFixture();
    const host = await w.boot(fx.implementations);
    await w.clock.advance(0);
    expect(fx.runs()).toBe(1);
    expect(fx.count()).toBe(1);
    const cachedMode = host.hooks.provider(SessionModes, 'device');
    if (cachedMode === 'unavailable') throw new Error('mode');
    const client = clientFor(host);
    await client.handshake(host.identity.daemonId);
    await client.auth(await pairedDevice(fx.mode));
    expect(client.last('authenticated')).toBeDefined();
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/board/live'));
    if (decision.outcome !== 'accepted') throw new Error('upgrade');
    let closed = 0;
    await decision.attach({
      send: () => 0,
      close: () => {
        closed++;
      },
      bufferedBytes: () => 0,
    });
    w.fs.seed(`${w.home}/state/access/policy.json`, '{ broken');
    expect((await fx.state().read(Policy)).ok).toBe(false);
    expect(host.plugins.get('access')?.status).toBe('damaged');
    expect(host.plugins.get('board')?.status).toBe('failed');
    expect(host.plugins.get('agenda')?.status).toBe('failed');
    expect(() => fx.count()).toThrow('not running');
    expect(() => fx.boundCount()).toThrow('not running');
    expect(() => cachedMode.holder).toThrow('not running');
    expect(closed).toBe(1);
    expect(fx.streamClosed()).toBe(1);
    await client.pump();
    expect(client.end?.code).toBe(4403);
    expect((await host.dispatch(request('GET', '/v1/access'))).status).toBe(503);
    expect((await host.dispatch(request('GET', '/v1/board'))).status).toBe(503);
    host.events.publish(Tick, { value: 1 });
    await w.clock.advance(100);
    await host.jobs.settle();
    expect(fx.heard()).toBe(0);
    expect(fx.aborted()).toBe(1);
    expect(fx.runs()).toBe(1);
    expect(await host.doctor()).toContainEqual(expect.objectContaining({ plugin: 'access', state: 'fail' }));
    w.fs.seed(`${w.home}/state/access/policy.json`, '{"format":1,"value":1}');
    await fx.state().read(Policy);
    expect(host.plugins.get('access')?.status).toBe('serving');
    expect(host.plugins.get('board')?.status).toBe('serving');
    expect(host.plugins.get('agenda')?.status).toBe('serving');
    expect((await host.dispatch(request('GET', '/v1/board'))).status).toBe(200);
    expect((await host.doctor()).some(line => line.plugin === 'access' && line.state === 'fail')).toBe(false);
  });

  test('damage to a bound Gate revokes admission and existing sessions immediately', async () => {
    const w = await world();
    const fx = accessFixture();
    let state: StatePort | undefined;
    const damagedGate = definePlugin({ ...gate, data: { state: [Policy] } });
    const host = await w.boot([
      implementDaemon(damagedGate, {
        build: ctx => {
          state = ctx.kernel.state;
          return { provides: { admission: recordingAdmission() } };
        },
      }),
      ...fx.implementations.slice(1),
    ]);
    const client = clientFor(host);
    await client.handshake(host.identity.daemonId);
    await client.auth(await pairedDevice(fx.mode));
    w.fs.seed(`${w.home}/state/gate/policy.json`, '{ broken');
    await state?.read(Policy);
    const response = await host.dispatch(request('GET', '/v1/board'));
    expect(JSON.parse(response.body).code).toBe('admission_unavailable');
    expect(host.sessionLayer.report().sessions).toBe(0);
    w.fs.seed(`${w.home}/state/gate/policy.json`, '{"format":1,"value":1}');
    await state?.read(Policy);
    expect((await host.dispatch(request('GET', '/v1/board'))).status).toBe(200);
  });

  test('an admission that says its policy moved re-asks every open stream at once; the subscription ends with the host', async () => {
    const w = await world();
    const fx = accessFixture();
    const listeners = new Set<() => void>();
    let stillAdmitted = true;
    const watched = {
      ...recordingAdmission(),
      readmit: () => stillAdmitted,
      watch: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const host = await w.boot([
      implementDaemon(gate, { build: () => ({ provides: { admission: watched } }) }),
      ...fx.implementations.slice(1),
    ]);
    expect(listeners.size).toBe(1);
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/board/live'));
    if (decision.outcome !== 'accepted') throw new Error('upgrade');
    const closes: number[] = [];
    await decision.attach({
      send: () => 0,
      close: code => {
        closes.push(code);
      },
      bufferedBytes: () => 0,
    });
    // Nothing moved: the notice alone closes nothing.
    for (const listener of [...listeners]) listener();
    expect(closes).toEqual([]);
    // The policy narrowed: the notice re-asks the open stream now, with no frame and no renewal in between.
    stillAdmitted = false;
    for (const listener of [...listeners]) listener();
    expect(closes).toEqual([4401]);
    await host.stop();
    expect(listeners.size).toBe(0);
  });

  test('jobs and onStop resources from a failed build are discarded, including transitive dependents', async () => {
    const w = await world();
    const fx = accessFixture();
    let runs = 0;
    let stops = 0;
    const broken = implementDaemon(fx.implementations[1]!.manifest, {
      build: ctx => {
        ctx.kernel.lifecycle.onStop(() => {
          stops++;
        });
        ctx.kernel.jobs.add({
          id: 'must-not-start',
          schedule: { onceAfterStart: true },
          run: async () => {
            runs++;
          },
        });
        throw new Error('build failed');
      },
    });
    const host = await w.boot([gateHalf(), broken, ...fx.implementations.slice(2)]);
    await w.clock.advance(100);
    expect(runs).toBe(0);
    expect(stops).toBe(1);
    expect(host.jobs.reports()).toEqual([]);
    expect(host.plugins.get('board')?.status).toBe('failed');
    expect(host.plugins.get('agenda')?.status).toBe('failed');
  });

  test('boot honours a narrower lower-format refusal without moving the folder or damaging the subsystem', async () => {
    const w = await world();
    const narrow = defineState({ ...Policy, onDamaged: { narrower: 'refuse' } });
    const manifest = definePlugin({ ...base, id: 'narrow', title: 'Narrow', data: { state: [narrow] } });
    const path = `${w.home}/state/narrow/policy.json`;
    w.fs.seed(path, '{"format":0,"value":1}');
    const host = await w.boot([implementDaemon(manifest, { build: () => ({}) })]);
    expect(host.plugins.get('narrow')?.status).toBe('serving');
    expect(w.fs.snapshot().get(path)).toBe('{"format":0,"value":1}');
    expect(await host.doctor()).toContainEqual(expect.objectContaining({ plugin: 'narrow', state: 'warn' }));
    expect(await host.plugins.get('narrow')?.state?.port.read(narrow)).toEqual({ ok: true, value: undefined });
  });
});

describe('guarded host tools (§7.3)', () => {
  test('missing, throwing, damaged guards withhold returned and thrown tool content', async () => {
    for (const kind of ['missing', 'stamp-throws', 'check-throws', 'damaged'] as const) {
      const w = await world();
      let handled = 0;
      const vault = definePlugin({
        ...base,
        id: 'vault',
        title: 'Vault',
        core: true,
        provides: { output: OutputGuardPort },
        data: { state: [Policy] },
      });
      if (kind === 'damaged') w.fs.seed(`${w.home}/state/vault/policy.json`, '{ broken');
      const guard: OutputGuard = {
        stamp: () => {
          if (kind === 'stamp-throws') throw new Error('damaged');
          return { generation: 1, targets: [] };
        },
        stillShowable: () => {
          if (kind === 'check-throws') throw new Error('damaged');
          return true;
        },
      };
      const tools = definePlugin({
        ...base,
        id: 'fixture-tools',
        title: 'Tools',
        actions: {
          agentTools: [tool('read', { ...scope, guard: 'secrets' }), tool('fail', { ...scope, guard: 'secrets' })],
        },
      });
      const host = await w.boot([
        gateHalf(),
        ...(kind === 'missing'
          ? []
          : [
              implementDaemon(vault, {
                build: () => ({ provides: { output: guard } }),
              }),
            ]),
        implementDaemon(tools, {
          build: () => ({
            tools: {
              read: async () => {
                handled++;
                return { text: 'fixture-content', data: { private: 'fixture-content' } };
              },
              fail: async () => {
                handled++;
                throw new ApiError(409, 'fixture-content');
              },
            },
          }),
        }),
      ]);
      for (const name of ['read', 'fail']) {
        const result = await host.callTool('fixture-tools', name, {}, request('POST', '/v1/tools/read'));
        expect(JSON.stringify(result)).toBe(JSON.stringify({ text: WITHHELD_SENTENCE, isError: true }));
      }
      if (kind !== 'check-throws') expect(handled).toBe(0);
    }
  });

  test('a hold during a tool handler withholds both success and ApiError content', async () => {
    for (const throwing of [false, true]) {
      const w = await world();
      let generation = 1;
      const vault = definePlugin({
        ...base,
        id: 'vault',
        title: 'Vault',
        core: true,
        provides: { output: OutputGuardPort },
      });
      const tools = definePlugin({
        ...base,
        id: 'fixture-tools',
        title: 'Tools',
        actions: {
          agentTools: [tool('read', { ...scope, guard: 'secrets' })],
        },
      });
      const host = await w.boot([
        gateHalf(),
        implementDaemon(vault, {
          build: () => ({
            provides: {
              output: {
                stamp: () => ({ generation, targets: [] }),
                stillShowable: stamp => stamp.generation === generation,
              },
            },
          }),
        }),
        implementDaemon(tools, {
          build: () => ({
            tools: {
              read: async () => {
                await Promise.resolve();
                generation++;
                if (throwing) throw new ApiError(409, 'fixture-content');
                return { text: 'fixture-content', data: { value: 'fixture-content' } };
              },
            },
          }),
        }),
      ]);
      expect(await host.callTool('fixture-tools', 'read', {}, request('POST', '/v1/tools/read'))).toEqual({
        text: WITHHELD_SENTENCE,
        isError: true,
      });
    }
  });

  test('a hold after callTool resolves still withholds every field at the tool transport JSON handoff', async () => {
    const w = await world();
    let generation = 1;
    const vault = definePlugin({
      ...base,
      id: 'vault',
      title: 'Vault',
      core: true,
      provides: { output: OutputGuardPort },
    });
    const tools = definePlugin({
      ...base,
      id: 'fixture-tools',
      title: 'Tools',
      actions: {
        agentTools: [tool('read', { ...scope, guard: 'secrets' })],
      },
    });
    const host = await w.boot([
      gateHalf(),
      implementDaemon(vault, {
        build: () => ({
          provides: {
            output: {
              stamp: () => ({ generation, targets: [] }),
              stillShowable: stamp => stamp.generation === generation,
            },
          },
        }),
      }),
      implementDaemon(tools, {
        build: () => ({
          tools: {
            read: async () => ({
              text: 'fixture-content',
              data: { value: 'fixture-content' },
            }),
          },
        }),
      }),
    ]);
    const result = await host.callTool('fixture-tools', 'read', {}, request('POST', '/v1/tools/read'));
    expect(result.text).toBe('fixture-content');
    generation++;
    expect(JSON.parse(JSON.stringify(result))).toEqual({ text: WITHHELD_SENTENCE, isError: true });
  });
});

describe('boot unwind (§7.6)', () => {
  test('a throw after listen stops the acquired listener before build, state, watcher and lock resources', async () => {
    const w = await world();
    const connections = definePlugin({
      ...base,
      id: 'connections',
      title: 'Connections',
      hooks: { takes: [{ hook: Carriers, key: 'relay' }] },
    });
    await expect(
      w.boot(
        [
          implementDaemon(connections, {
            build: ctx => {
              ctx.kernel.lifecycle.onStop(() => {
                w.trace.push('build:stop');
              });
              return {
                hooks: {
                  'carriers:relay': {
                    start: () => {
                      throw new Error('carrier failed');
                    },
                    status: () => ({ state: 'failed', sentence: 'fixture' }),
                  },
                },
              };
            },
          }),
        ],
        {
          listen: async () => ({
            addresses: ['fixture'],
            stop: async () => {
              w.trace.push('listener:stop');
            },
          }),
        },
      ),
    ).rejects.toThrow('carrier failed');
    expect(w.trace.slice(-5)).toEqual([
      'listener:stop',
      'build:stop',
      'state:connections:stop',
      'watch:stop',
      'lock:stop',
    ]);
  });

  test('a graph refusal releases the watcher before the home lock', async () => {
    const w = await world();
    const Missing = definePort<object>('missing');
    const refusedGate = definePlugin({ ...gate, needs: { missing: Missing } });
    const result = await bootHost({
      ...w.options,
      implementations: [
        implementDaemon(refusedGate, {
          build: () => ({
            provides: { admission: recordingAdmission() },
          }),
        }),
      ],
    });
    expect(result.kind).toBe('refused');
    expect(w.trace).toEqual(['watch:start', 'watch:stop', 'lock:stop']);
  });

  test('a core build refusal unwinds build resources, opened states, watcher and lock in reverse', async () => {
    const w = await world();
    const result = await bootHost({
      ...w.options,
      implementations: [
        implementDaemon(gate, {
          build: ctx => {
            ctx.kernel.lifecycle.onStop(() => {
              w.trace.push('gate:build:stop');
            });
            throw new Error('core build failed');
          },
        }),
      ],
    });
    expect(result.kind).toBe('refused');
    expect(w.trace.slice(-4)).toEqual(['gate:build:stop', 'state:gate:stop', 'watch:stop', 'lock:stop']);
  });

  test('a throw while opening state releases even the partially opened handle and the watcher', async () => {
    const w = await world();
    const adapters = {
      ...w.options.adapters,
      state: (manifest: Parameters<HostOptions['adapters']['state']>[0]) => {
        const handle = w.options.adapters.state(manifest);
        return {
          ...handle,
          open: async () => {
            throw new Error('open failed');
          },
        };
      },
    };
    await expect(bootHost({ ...w.options, adapters, implementations: [gateHalf()] })).rejects.toThrow('open failed');
    expect(w.trace.slice(-3)).toEqual(['state:gate:stop', 'watch:stop', 'lock:stop']);
  });

  test('kernel.bind is empty while plugins build, answers what the listener bound, and is empty again once stopped', async () => {
    const w = await world();
    let asked: (() => { host: string; port: number } | undefined) | undefined;
    let atBuild: unknown = 'unread';
    const reader = implementDaemon(gate, {
      build: ctx => {
        asked = () => ctx.kernel.bind.current();
        atBuild = ctx.kernel.bind.current();
        return { provides: { admission: recordingAdmission() } };
      },
    });
    const host = await w.boot([reader], {
      listen: async () => ({
        addresses: ['fixture'],
        bound: { host: '127.0.0.1', port: 7458 },
        stop: async () => undefined,
      }),
    });
    expect(atBuild).toBeUndefined();
    expect(asked?.()).toEqual({ host: '127.0.0.1', port: 7458 });
    await host.stop();
    expect(asked?.()).toBeUndefined();
  });

  test('kernel.bind stays empty when the listener reports no TCP address', async () => {
    const w = await world();
    let asked: (() => unknown) | undefined;
    const reader = implementDaemon(gate, {
      build: ctx => {
        asked = () => ctx.kernel.bind.current();
        return { provides: { admission: recordingAdmission() } };
      },
    });
    await w.boot([reader], { listen: async () => ({ addresses: ['fixture'], stop: async () => undefined }) });
    expect(asked?.()).toBeUndefined();
  });

  test('a listener throw releases sessions, build resources, state, watcher and lock', async () => {
    const w = await world();
    let live: RunningHost | undefined;
    await expect(
      w.boot([gateHalf()], {
        listen: async host => {
          live = host;
          host.sessionLayer.open('relay' as CarrierKey);
          throw new Error('listen failed');
        },
      }),
    ).rejects.toThrow('listen failed');
    expect(live?.sessionLayer.report().sessions).toBe(0);
    expect(w.trace.slice(-3)).toEqual(['state:gate:stop', 'watch:stop', 'lock:stop']);
  });
});
