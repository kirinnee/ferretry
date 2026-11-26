/** C-27 C-79: a failed subscriber is logged with its reason; the kernel's routes, children and file calls reach an observer by name and duration only. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort } from '../../../contract/bound.ts';
import type { EventDef } from '../../../contract/define.ts';
import type { LogFields, SpawnPort, WorkObserver } from '../../../contract/ports.ts';
import { EventBus } from '../../../host/events.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { scopedLog } from '../../../host/log.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { Dispatcher, type MountedRoute, type Owner } from '../../../host/dispatch.ts';
import { jsonResponse } from '../../../contract/http.ts';
import type { PluginId } from '../../../contract/ids.ts';
import { tapFs, tapSpawn, timedRoute, WorkFeed } from '../../../host/work-feed.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request, silentLog } from './fixtures.ts';

const Ping = { name: 'test.ping', schema: z.object({}) } as unknown as EventDef;

const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 5));
};

describe('C-27 a failed subscriber is logged with its reason', () => {
  const rig = () => {
    const warned: { message: string; fields: LogFields | undefined }[] = [];
    const log = scopedLog(record => {
      if (record.level === 'warn') warned.push({ message: record.message, fields: record.fields });
    }, 'events');
    return { warned, bus: new EventBus(log) };
  };

  test('names the error kind and code, never its message', async () => {
    const { bus, warned } = rig();
    bus.subscribe('alpha', Ping, () => {
      throw Object.assign(new Error('token=sk-live-abc123 refused'), { code: 'ECONNRESET' });
    });
    bus.publish(Ping, {});
    await tick();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toBe('a subscriber failed');
    expect(warned[0]?.fields).toEqual({ event: 'test.ping', plugin: 'alpha', reason: 'Error ECONNRESET' });
    expect(JSON.stringify(warned)).not.toContain('sk-live');
  });

  test('a renamed error is logged by its real kind, and an unrecognised code is left out', async () => {
    const { bus, warned } = rig();
    bus.subscribe('alpha', Ping, () => {
      throw Object.assign(new TypeError('x'), { name: 'sk-live-abc123', code: 'X'.repeat(30) });
    });
    bus.subscribe('beta', Ping, () => {
      throw Object.assign(new Error('x'), { code: 'EWHATEVER' });
    });
    bus.publish(Ping, {});
    await tick();
    expect(warned.map(w => w.fields?.reason).sort()).toEqual(['Error', 'TypeError']);
    expect(JSON.stringify(warned)).not.toContain('sk-live');
  });

  test('an error that cannot be inspected is logged as unknown', async () => {
    const { bus, warned } = rig();
    const hostile = new Proxy(new Error('x'), {
      get: () => {
        throw new Error('trap');
      },
      getPrototypeOf: () => {
        throw new Error('trap');
      },
    });
    bus.subscribe('alpha', Ping, () => Promise.reject(hostile));
    bus.publish(Ping, {});
    await tick();
    expect(warned[0]?.fields?.reason).toBe('unknown');
  });

  test('a thrown non-error says so, and never its value', async () => {
    const { bus, warned } = rig();
    bus.subscribe('alpha', Ping, () => Promise.reject('secret-string'));
    bus.publish(Ping, {});
    await tick();
    expect(warned[0]?.fields).toEqual({ event: 'test.ping', plugin: 'alpha', reason: 'a non-error value was thrown' });
  });
});

type Heard = { route: unknown[][]; started: string[]; exited: [string, number][]; file: [string, number][] };
const hearing = (): { heard: Heard; observer: WorkObserver } => {
  const heard: Heard = { route: [], started: [], exited: [], file: [] };
  return {
    heard,
    observer: {
      route: (...args) => heard.route.push(args),
      childStarted: program => heard.started.push(program),
      childExited: (program, wallMs) => heard.exited.push([program, wallMs]),
      file: (operation, wallMs) => heard.file.push([operation, wallMs]),
    },
  };
};
const clockOf = (...readings: number[]): (() => number) => {
  let next = 0;
  return () => readings[Math.min(next++, readings.length - 1)] ?? 0;
};

describe('C-79 the kernel feed', () => {
  test('a spawned child is heard by its program name only, with its wall time; the arguments never are', async () => {
    const feed = new WorkFeed();
    const { heard, observer } = hearing();
    feed.observe(observer);
    const inner = {
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    } as unknown as SpawnPort;
    await tapSpawn(inner, feed, clockOf(10, 35)).run('/usr/bin/git', ['push', 'https://user:hunter2@host/x.git']);
    expect(heard.started).toEqual(['git']);
    expect(heard.exited).toEqual([['git', 25]]);
    expect(JSON.stringify(heard)).not.toContain('hunter2');
  });

  test('a program outside the known set is heard as "other", never by its filename', async () => {
    const feed = new WorkFeed();
    const { heard, observer } = hearing();
    feed.observe(observer);
    const inner = { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }) } as unknown as SpawnPort;
    const spawn = tapSpawn(inner, feed, clockOf(0, 1, 2, 3));
    await spawn.run('/opt/acme/my-secret-mcp-server', []);
    await spawn.run('/usr/bin/git', []);
    expect(heard.started).toEqual(['other', 'git']);
    expect(JSON.stringify(heard)).not.toContain('secret');
  });

  test('an observer that rejects asynchronously never escapes as an unhandled rejection', async () => {
    const feed = new WorkFeed();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      feed.observe({
        route: async () => {
          throw new Error('async observer');
        },
        childStarted: () => {},
        childExited: () => {},
        file: () => {},
      } as unknown as WorkObserver);
      feed.emit(observer => observer.route('GET /x', 1, 200, 1));
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });

  test('a route key is the declared method and template, or "unrouted"; a caller-chosen method never becomes a key', async () => {
    const feed = new WorkFeed();
    const { heard, observer } = hearing();
    feed.observe(observer);
    const miss = async () => jsonResponse({}, 404);
    for (const method of ['ZZZ1', 'ZZZ2', 'ZZZ3']) await timedRoute(feed, request(method, '/nope'), miss);
    expect(heard.route.map(([route]) => route)).toEqual(['unrouted', 'unrouted', 'unrouted']);
  });

  test('a matched member route is reported by its declared method and template', async () => {
    const feed = new WorkFeed();
    const { heard, observer } = hearing();
    feed.observe(observer);
    const owner: Owner = { plugin: 'board' as PluginId, title: 'Board', serving: () => ({ kind: 'serving' }) };
    const route = {
      method: 'GET',
      path: '/v1/catalogs/:id',
      minimum: 'authenticated',
      caller: 'any',
      audit: { skip: 'test' },
      guard: { none: 'test' },
      member: 'unlocked',
      noStore: true,
      owner,
      handle: async () => jsonResponse({}),
    } as unknown as MountedRoute;
    const dispatcher = new Dispatcher(
      { admission: () => recordingAdmission(), outputGuard: () => undefined, version: '5.0.0', work: feed },
      { routes: [], sockets: [], memberRoutes: [route as never] },
    );
    const input = request('GET', '/v1/catalogs/abc');
    Object.assign(input, {
      principal: { kind: 'member', holder: 'm', session: 's', leaseUntil: '2026-11-07T10:00:00.000Z' },
    });
    await dispatcher.dispatch(input);
    expect(heard.route.map(([r]) => r)).toEqual(['GET /v1/catalogs/:id']);
  });

  test('a failed child still has its exit heard, and nothing is measured with no observer', async () => {
    const feed = new WorkFeed();
    const inner = {
      run: async () => {
        throw new Error('boom');
      },
    } as unknown as SpawnPort;
    const quiet = tapSpawn(inner, feed, () => {
      throw new Error('the clock was read with nobody listening');
    });
    await expect(quiet.run('git', [])).rejects.toThrow('boom');
    const { heard, observer } = hearing();
    const stop = feed.observe(observer);
    await expect(tapSpawn(inner, feed, clockOf(0, 4)).run('git', [])).rejects.toThrow('boom');
    expect(heard.exited).toEqual([['git', 4]]);
    stop();
    expect(feed.recording).toBe(false);
  });

  test('a host filesystem call is heard by its method name, never its path, and its result still returns', async () => {
    const feed = new WorkFeed();
    const { heard, observer } = hearing();
    feed.observe(observer);
    const seen: string[] = [];
    const inner = {
      readText: async (path: string) => {
        seen.push(path);
        return 'file content';
      },
    } as unknown as Parameters<typeof tapFs>[0];
    const fs = tapFs(inner, feed, clockOf(1, 9));
    expect(await fs.readText('/home/me/.ssh/id_rsa')).toBe('file content');
    expect(seen).toEqual(['/home/me/.ssh/id_rsa']);
    expect(heard.file).toEqual([['readText', 8]]);
    expect(JSON.stringify(heard)).not.toContain('id_rsa');
    expect(JSON.stringify(heard)).not.toContain('file content');
  });

  describe('through a booted host', () => {
    const parents: string[] = [];
    const hosts: RunningHost[] = [];
    afterEach(async () => {
      for (const host of hosts.splice(0)) await host.stop();
      for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
    });

    test('a plugin hears each route the dispatcher serves by its template, never the caller’s path, until it stops', async () => {
      let observeWork: ((observer: WorkObserver) => () => void) | undefined;
      const hearer = implementDaemon(
        definePlugin({ id: 'hearer', title: 'Hearer', version: '5.0.0', api: 5, core: false, kinds: [] }),
        {
          build: ctx => {
            observeWork = ctx.kernel.loop.observeWork;
            return {};
          },
        },
      );
      const admission = implementDaemon(
        definePlugin({
          id: 'gate',
          title: 'Gate',
          version: '5.0.0',
          api: 5,
          core: true,
          kinds: [],
          provides: { admission: AdmissionPort },
        }),
        { build: () => ({ provides: { admission: recordingAdmission() } }) },
      );
      const parent = await mkdtemp(`${tmpdir()}/kernel-work-`);
      parents.push(parent);
      const home = `${parent}/home`;
      const fixed = fixedClock();
      const options: HostOptions = {
        home,
        version: '5.0.0',
        implementations: [admission, hearer],
        adapters: {
          ...realAdapters(home, () => {}, { binary: 'fy' }),
          clock: fixed,
          homeLock: async () => ({ release: async () => {} }),
          state: stateOpener(home, createMemoryHostFs(), fixed, silentLog),
        },
      };
      const outcome = await bootHost(options);
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      hosts.push(outcome.host);
      const { heard, observer } = hearing();
      const stop = (observeWork as (o: WorkObserver) => () => void)(observer);
      await outcome.host.dispatch(request('GET', '/healthz', { local: true }));
      await outcome.host.dispatch(request('GET', '/v1/nothing/sk-live-123', { local: true }));
      expect(heard.route.map(([route]) => route)).toEqual(['GET /healthz', 'unrouted']);
      expect(JSON.stringify(heard)).not.toContain('sk-live');
      stop();
      await outcome.host.dispatch(request('GET', '/healthz', { local: true }));
      expect(heard.route).toHaveLength(2);
    });
  });
});
