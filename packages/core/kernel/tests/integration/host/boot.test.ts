import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, type Admission } from '../../../contract/bound.ts';
import { defineEvent, definePort, defineState } from '../../../contract/define.ts';
import { jsonResponse } from '../../../contract/http.ts';
import { DoctorChecks } from '../../../contract/kernel.ts';
import { milliseconds } from '@ferretry/std';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route, skeletonDaemon } from '../../../manifest/index.ts';
import { recordingAdmission, request } from '../../unit/host/fixtures.ts';

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
  const parent = await mkdtemp(`${tmpdir()}/fy-kernel-`);
  homes.push(parent);
  return `${parent}/home`;
}

interface BoardApi {
  count(): number;
}
const BoardPort = definePort<BoardApi>('board');
const CardMoved = defineEvent('board.card-moved', z.strictObject({ card: z.string() }));
const Cards = defineState({
  name: 'cards',
  path: 'cards.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), cards: z.array(z.string()) }),
});

function plugins(admission: Admission, events: string[]) {
  const gate = definePlugin({
    id: 'gate',
    title: 'Gate',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    provides: { admission: AdmissionPort },
  });
  const board = definePlugin({
    id: 'board',
    title: 'Board',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    provides: { board: BoardPort },
    actions: {
      routes: [
        route('GET /v1/board', {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'test' },
          guard: { none: 'test' },
        }),
      ],
    },
    data: { state: [Cards], publishes: [CardMoved] },
    hooks: { takes: [{ hook: DoctorChecks }] },
    doctor: ['board-ok'],
  });
  const agenda = definePlugin({
    id: 'agenda',
    title: 'Agenda',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { board: BoardPort },
    data: { subscribes: [CardMoved] },
    actions: {
      routes: [
        route('GET /v1/agenda', {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'test' },
          guard: { none: 'test' },
        }),
      ],
    },
  });
  const voice = definePlugin({
    id: 'voice',
    title: 'Voice',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: {
      routes: [
        route('GET /v1/voice', {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'test' },
          guard: { none: 'test' },
        }),
      ],
    },
  });
  return [
    implementDaemon(gate, { build: () => ({ provides: { admission } }) }),
    implementDaemon(board, {
      build: ctx => {
        ctx.kernel.jobs.add({
          id: 'tick',
          schedule: { onceAfterStart: true, delay: milliseconds(0) },
          run: async () => {
            events.push('job');
            ctx.kernel.events.publish(CardMoved, { card: 'F1' });
          },
        });
        return {
          provides: { board: { count: () => 1 } },
          routes: {
            'GET /v1/board': async () => {
              await ctx.kernel.state.write(Cards, { format: 1, cards: ['F1'] });
              return jsonResponse({ cards: 1 });
            },
          },
          hooks: {
            'doctor.checks': () => [
              {
                id: 'board-ok',
                item: { id: 'board-ok', title: 'Board', run: async () => ({ state: 'ok', detail: 'fine' }) },
              },
            ],
          },
        };
      },
    }),
    implementDaemon(agenda, {
      build: ctx => ({
        routes: { 'GET /v1/agenda': async () => jsonResponse({ boardCount: ctx.needs.board.count() }) },
        subscribers: { 'board.card-moved': payload => void events.push(`heard:${payload.card}`) },
      }),
    }),
    skeletonDaemon(voice),
  ];
}

async function boot(home: string, admission: Admission = recordingAdmission(), events: string[] = []) {
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: plugins(admission, events),
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  running.push(outcome.host);
  return outcome.host;
}

const body = (response: { body: string }): unknown => JSON.parse(response.body);

describe('boot (§7.6)', () => {
  test('the boot trace follows §7.6 and the start order the manifests imply', async () => {
    const host = await boot(await freshHome());
    await host.stop();
    expect(host.trace).toEqual([
      'home',
      'lock',
      'identity',
      'config',
      'check',
      'state:gate',
      'state:board',
      'state:agenda',
      'state:voice',
      'build:gate',
      'build:board',
      'build:agenda',
      'build:voice',
      'bind',
      'snapshot',
      'mount',
      'listen',
      'jobs',
      'stop:listen',
      'stop:jobs',
      'stop:voice',
      'stop:agenda',
      'stop:board',
      'stop:gate',
      'stop:kernel',
      'stop:lock',
    ]);
  });

  test('a fresh home gets home.json and a 0600 identity; a second boot keeps the same identity', async () => {
    const home = await freshHome();
    const first = await boot(home);
    const id = first.identity.daemonId;
    await first.stop();
    expect(JSON.parse(await readFile(`${home}/home.json`, 'utf8')).format).toBe(1);
    expect((await stat(`${home}/state/kernel/identity.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    const second = await boot(home);
    expect(second.identity.daemonId).toBe(id);
    expect(id).toMatch(/^fy_daemon_[A-Za-z0-9_-]{43}$/);
  });

  test('S50 a home the daemon cannot use is refused, never guessed, and nothing is touched', async () => {
    const home = await freshHome();
    await mkdir(home, { recursive: true });
    await writeFile(`${home}/notes.txt`, 'mine');
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [],
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    });
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.sentence).toContain('has no home.json');
    expect(await readFile(`${home}/notes.txt`, 'utf8')).toBe('mine');
  });

  test('a damaged identity refuses the boot instead of minting a new one', async () => {
    const home = await freshHome();
    await (await boot(home)).stop();
    running.splice(0);
    await writeFile(`${home}/state/kernel/identity.json`, '{"format":2}');
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [],
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    });
    expect(outcome.kind).toBe('refused');
  });

  test('routes are served behind admission; a need reaches its provider; a skeleton answers plugin_unavailable', async () => {
    const admission = recordingAdmission();
    const host = await boot(await freshHome(), admission);
    expect(body(await host.dispatch(request('GET', '/v1/board')))).toEqual({ cards: 1 });
    expect(body(await host.dispatch(request('GET', '/v1/agenda')))).toEqual({ boardCount: 1 });
    const skeleton = await host.dispatch(request('GET', '/v1/voice'));
    expect(skeleton.status).toBe(503);
    expect(body(skeleton)).toEqual({
      error: 'Voice is not built yet in this version of Ferretry.',
      code: 'plugin_unavailable',
    });
    expect(admission.asked).toEqual(['route GET /v1/board', 'route GET /v1/agenda', 'route GET /v1/voice']);
  });

  test('GET /v1/health answers the protocol and version pre-auth; /v1/plugins without a projection shows core only', async () => {
    const host = await boot(
      await freshHome(),
      recordingAdmission(path => path === '/v1/health'),
    );
    expect(body(await host.dispatch(request('GET', '/v1/health')))).toEqual({ protocol: 1, version: '5.0.0' });
    const permissive = await boot(await freshHome());
    const inventory = body(await permissive.dispatch(request('GET', '/v1/plugins'))) as { plugins: { id: string }[] };
    expect(inventory.plugins.map(plugin => plugin.id).sort()).toEqual(['agenda', 'board', 'gate', 'kernel', 'voice']);
    const glossary = body(await permissive.dispatch(request('GET', '/v1/glossary'))) as { words: { word: string }[] };
    expect(glossary.words.map(word => word.word)).toContain('home');
  });

  test('jobs start after listen, events reach subscribers, doctor runs contributed checks', async () => {
    const events: string[] = [];
    const host = await boot(await freshHome(), recordingAdmission(), events);
    for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toEqual(['job', 'heard:F1']);
    expect(await host.doctor()).toContainEqual({ plugin: 'board-ok', state: 'ok', detail: 'fine' });
  });

  test('a plugin turned off is not mounted, and what needs it is not started', async () => {
    const home = await freshHome();
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: plugins(recordingAdmission(), []),
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
      enabled: id => id !== 'board',
    });
    if (outcome.kind !== 'running') throw new Error('refused');
    running.push(outcome.host);
    expect((await outcome.host.dispatch(request('GET', '/v1/board'))).status).toBe(404);
    expect(outcome.host.plugins.get('agenda')?.status).toBe('refused');
  });

  test('a plugin whose build throws is failed, its dependents too, and the rest boots', async () => {
    const home = await freshHome();
    const impls = plugins(recordingAdmission(), []).map(impl =>
      impl.manifest.id === 'board'
        ? implementDaemon(impl.manifest, {
            build: () => {
              throw new Error('no');
            },
          })
        : impl,
    );
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: impls,
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    });
    if (outcome.kind !== 'running') throw new Error('refused');
    running.push(outcome.host);
    expect(outcome.host.plugins.get('board')?.status).toBe('failed');
    expect(outcome.host.plugins.get('agenda')?.status).toBe('failed');
    expect((body(await outcome.host.dispatch(request('GET', '/v1/board'))) as { code: string }).code).toBe(
      'plugin_failed',
    );
  });

  test('a damaged state file makes the plugin answer store_damaged naming the file', async () => {
    const home = await freshHome();
    const first = await boot(home);
    await first.dispatch(request('GET', '/v1/board'));
    await first.stop();
    running.splice(0);
    await writeFile(`${home}/state/board/cards.json`, '{"format":9,"cards":[]}');
    const host = await boot(home);
    const response = await host.dispatch(request('GET', '/v1/board'));
    expect(response.status).toBe(503);
    expect((body(response) as { code: string; error: string }).code).toBe('store_damaged');
  });
});

describe('GET /v1/plugins is projected by Gate (§9.6)', () => {
  test('Gate’s projection decides what a caller sees; a throwing projection shows core only', async () => {
    const limited = {
      ...recordingAdmission(),
      inventory: (_request: unknown, entries: readonly { id: string }[]) =>
        entries.filter(entry => entry.id !== 'voice'),
    };
    const host = await boot(await freshHome(), limited as never);
    const seen = body(await host.dispatch(request('GET', '/v1/plugins'))) as { plugins: { id: string; on: boolean }[] };
    expect(seen.plugins.map(plugin => plugin.id).sort()).toEqual(['agenda', 'board', 'gate', 'kernel']);
    const broken = {
      ...recordingAdmission(),
      inventory: () => {
        throw new Error('x');
      },
    };
    const other = await boot(await freshHome(), broken as never);
    const core = body(await other.dispatch(request('GET', '/v1/plugins'))) as { plugins: { id: string }[] };
    expect(core.plugins.map(plugin => plugin.id)).toEqual(['kernel', 'gate']);
  });
});

describe('config/plugins.yaml (§3.6)', () => {
  test('a plugin turned off in plugins.yaml is not mounted; core cannot be turned off', async () => {
    const home = await freshHome();
    await (await boot(home)).stop();
    running.splice(0);
    await writeFile(`${home}/config/plugins.yaml`, '# owner notes\nplugins:\n  voice: off\n  gate: off\n');
    const host = await boot(home);
    expect(host.plugins.get('voice')?.status).toBe('off');
    expect((await host.dispatch(request('GET', '/v1/voice'))).status).toBe(404);
    expect(host.plugins.get('gate')?.status).toBe('serving');
  });

  test('turning a plugin on is a loosening edit; turning it off is not', async () => {
    const { PluginsConfig } = await import('../../../plugin.ts');
    expect(PluginsConfig.loosens({ plugins: { voice: 'off' } }, { plugins: { voice: 'on' } })).toEqual([
      'turns voice on',
    ]);
    expect(PluginsConfig.loosens({ plugins: { voice: 'off' } }, { plugins: {} })).toEqual([
      'turns voice on (its off line was removed)',
    ]);
    expect(PluginsConfig.loosens({ plugins: {} }, { plugins: { voice: 'off' } })).toEqual([]);
  });
});
