import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, type Admission } from '../../../contract/bound.ts';
import { defineEvent, definePort, defineState } from '../../../contract/define.ts';
import { jsonResponse } from '../../../contract/http.ts';
import { DoctorChecks, SESSION_CREDENTIAL_FEATURE } from '../../../contract/kernel.ts';
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
const TaskMoved = defineEvent('board.card-moved', z.strictObject({ card: z.string() }));
const Tasks = defineState({
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
    data: { state: [Tasks], publishes: [TaskMoved] },
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
    data: { subscribes: [TaskMoved] },
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
            ctx.kernel.events.publish(TaskMoved, { card: 'F1' });
          },
        });
        return {
          provides: { board: { count: () => 1 } },
          routes: {
            'GET /v1/board': async () => {
              await ctx.kernel.state.write(Tasks, { format: 1, cards: ['F1'] });
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
          doctor: {
            'board-ok': async () => ({ state: 'warn', detail: 'two cards are stale', fix: 'Run fy board tidy.' }),
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

/**
 * Boards and agendas are off unless `config/plugins.yaml` says `work: on`, so a suite that exercises them says it first.
 * It goes through the owner's own door: a home is only made by a boot, so a fresh one is booted bare once; the edit is
 * held (turning `work` on is a loosening) until confirmed, exactly as for a person. A home that exists (a test that
 * wrote its own plugins.yaml) is left alone.
 */
async function workOn(home: string): Promise<void> {
  if (
    await stat(home).then(
      () => true,
      () => false,
    )
  )
    return;
  const bare = await bootRaw(home, ownerJudge(), []);
  await turnWorkOn(bare);
  await bare.stop();
}

/** An admission that lets the owner's config routes through, but never lets a loosening apply in the same act (it is held). */
const ownerJudge = (): Admission =>
  ({ ...recordingAdmission(), judgeConfigAccess: () => ({ allowed: true, mayLoosen: false }) }) as Admission;

/** Writes `work: on` as the owner and confirms the hold; returns what the write answered. */
async function turnWorkOn(host: RunningHost): Promise<{ outcome: string; confirmed: boolean }> {
  const put = body(
    await host.dispatch(
      request('PUT', '/v1/config/file', { body: JSON.stringify({ path: 'plugins.yaml', text: 'work: on\n' }) }),
    ),
  ) as { outcome: string; etag: string };
  if (put.outcome === 'applied') return { outcome: put.outcome, confirmed: true };
  const done = body(
    await host.dispatch(
      request('POST', '/v1/config/confirm', { body: JSON.stringify({ path: 'plugins.yaml', etag: put.etag }) }),
    ),
  ) as { confirmed: boolean };
  return { outcome: put.outcome, confirmed: done.confirmed };
}

async function boot(home: string, admission: Admission = recordingAdmission(), events: string[] = [], work = true) {
  if (work) await workOn(home);
  const host = await bootRaw(home, admission, events);
  running.push(host);
  return host;
}

async function bootRaw(home: string, admission: Admission, events: string[]) {
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: plugins(admission, events),
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
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

  test("a refused home is marked as the home's fault and never calls onHomeOpened; a usable home calls it once", async () => {
    const stray = await freshHome();
    await mkdir(stray, { recursive: true });
    await writeFile(`${stray}/notes.txt`, 'mine');
    let opened = 0;
    const refused = await bootHost({
      home: stray,
      version: '5.0.0',
      implementations: [],
      adapters: realAdapters(stray, () => {}, { binary: 'fy' }),
      onHomeOpened: () => {
        opened += 1;
      },
    });
    expect(refused.kind === 'refused' && refused.cause).toBe('home');
    expect(opened).toBe(0);
    const fresh = await freshHome();
    const started = await bootHost({
      home: fresh,
      version: '5.0.0',
      implementations: [],
      adapters: realAdapters(fresh, () => {}, { binary: 'fy' }),
      onHomeOpened: () => {
        opened += 1;
      },
    });
    if (started.kind === 'running') running.push(started.host);
    expect(started.kind).toBe('running');
    expect(opened).toBe(1);
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

  test('R-0097 GET /v1/health answers exactly the protocol, version and session.credential.1 pre-auth; /v1/plugins under a keep-everything projection lists every plugin', async () => {
    const host = await boot(
      await freshHome(),
      recordingAdmission(path => path === '/v1/health'),
    );
    // The whole unauthenticated answer, strictly: any new key leaking into it (a token, a digest, anything) fails here.
    const health = body(await host.dispatch(request('GET', '/v1/health')));
    expect(health).toStrictEqual({ protocol: 1, version: '5.0.0', features: [SESSION_CREDENTIAL_FEATURE] });
    // A fy from before 5.0 reads this name to know a 401 here is the answer, never a reason to open the admin token.
    expect((health as { features: string[] }).features).toContain('session.credential.1');
    expect(JSON.stringify(health)).not.toMatch(/token|digest|fys_|secret/i);
    const permissive = await boot(await freshHome());
    const inventory = body(await permissive.dispatch(request('GET', '/v1/plugins'))) as { plugins: { id: string }[] };
    expect(inventory.plugins.map(plugin => plugin.id).sort()).toEqual(['agenda', 'board', 'gate', 'kernel', 'voice']);
    const glossary = body(await permissive.dispatch(request('GET', '/v1/glossary'))) as { words: { word: string }[] };
    expect(glossary.words.map(word => word.word)).toContain('home');
  });

  test('G158 jobs start after listen, events reach subscribers, doctor runs contributed checks first', async () => {
    const events: string[] = [];
    const host = await boot(await freshHome(), recordingAdmission(), events);
    for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toEqual(['job', 'heard:F1']);
    expect(await host.doctor()).toContainEqual({ plugin: 'board-ok', state: 'ok', detail: 'fine' });
    // the manifest's declared check, run from the half's `doctor` section
    expect(await host.doctor()).toContainEqual({
      plugin: 'board',
      check: 'board-ok',
      state: 'warn',
      detail: 'two cards are stale',
      fix: 'Run fy board tidy.',
    });
    // G158: contributed checks (reachability) come before the declared ones
    const lines = await host.doctor();
    const contributed = lines.findIndex(line => line.plugin === 'board-ok');
    const declared = lines.findIndex(line => line.check === 'board-ok');
    expect(contributed).toBeGreaterThanOrEqual(0);
    expect(contributed).toBeLessThan(declared);
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
    await workOn(home);
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

describe('config/plugins.yaml `work`: the one switch for Board and Agenda (O8-14 P2)', () => {
  /** What a daemon on `home` serves, with the sentence each refused plugin carries. */
  async function standing(home: string, events: string[] = []) {
    const host = await boot(home, recordingAdmission(), events, false);
    const board = await host.dispatch(request('GET', '/v1/board'));
    const agenda = await host.dispatch(request('GET', '/v1/agenda'));
    return { host, board: board.status, agenda: agenda.status };
  }

  test('with `work` absent, Board and Agenda are off: routes 404, no job runs, nothing else is touched', async () => {
    const events: string[] = [];
    const { host, board, agenda } = await standing(await freshHome(), events);
    expect(host.plugins.get('board')?.status).toBe('off');
    expect(host.plugins.get('agenda')?.status).toBe('off');
    expect(board).toBe(404);
    expect(agenda).toBe(404);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toEqual([]);
    expect(host.plugins.get('voice')?.status).toBe('skeleton');
    expect(host.trace).not.toContain('build:board');
    // the inventory every client guard reads (`fy task`, `fy board`, the agenda verbs: "X is turned off") says off
    const seen = body(await host.dispatch(request('GET', '/v1/plugins'))) as { plugins: { id: string; on: boolean }[] };
    expect(
      seen.plugins.filter(plugin => plugin.id === 'board' || plugin.id === 'agenda').map(plugin => plugin.on),
    ).toEqual([false, false]);
  });

  test('`work: off` is the same as absent, and an own `on` line cannot turn a work plugin on without it', async () => {
    const home = await freshHome();
    await (await boot(home, recordingAdmission(), [], false)).stop();
    running.splice(0);
    await writeFile(`${home}/config/plugins.yaml`, 'work: off\nplugins:\n  board: on\n  agenda: on\n');
    const { host, board } = await standing(home);
    expect(host.plugins.get('board')?.status).toBe('off');
    expect(host.plugins.get('agenda')?.status).toBe('off');
    expect(board).toBe(404);
  });

  test('with `work: on`, today’s set is back: routes serve and the job runs', async () => {
    const events: string[] = [];
    const home = await freshHome();
    await workOn(home);
    const { host, board, agenda } = await standing(home, events);
    expect(host.plugins.get('board')?.status).toBe('serving');
    expect(host.plugins.get('agenda')?.status).toBe('serving');
    expect(board).toBe(200);
    expect(agenda).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toContain('job');
  });

  test('writing `work: on` is held for the owner, and Board stays off until it is confirmed', async () => {
    const home = await freshHome();
    const bare = await boot(home, ownerJudge(), [], false);
    const { outcome, confirmed } = await turnWorkOn(bare);
    expect(outcome).toBe('pending');
    expect(confirmed).toBe(true);
    await bare.stop();
    running.splice(0);
    const { host, board } = await standing(home);
    expect(host.plugins.get('board')?.status).toBe('serving');
    expect(board).toBe(200);
  });

  test('a hand-edited `work: on` nobody confirmed is held: the tighter version (work off) stays in effect', async () => {
    const home = await freshHome();
    await (await boot(home, recordingAdmission(), [], false)).stop();
    running.splice(0);
    await writeFile(`${home}/config/plugins.yaml`, 'work: on\n');
    const { host, board } = await standing(home);
    expect(host.plugins.get('board')?.status).toBe('off');
    expect(board).toBe(404);
  });

  test('a work plugin is on only if `work: on` AND its own line is not off', async () => {
    const { pluginsYamlSaysOn } = await import('../../../plugin.ts');
    expect(pluginsYamlSaysOn(undefined, 'board')).toBe(false);
    expect(pluginsYamlSaysOn({ plugins: {} }, 'agenda')).toBe(false);
    expect(pluginsYamlSaysOn({ work: 'off', plugins: { board: 'on' } }, 'board')).toBe(false);
    expect(pluginsYamlSaysOn({ work: 'on', plugins: {} }, 'board')).toBe(true);
    expect(pluginsYamlSaysOn({ work: 'on', plugins: { board: 'off' } }, 'board')).toBe(false);
    expect(pluginsYamlSaysOn({ work: 'on', plugins: { board: 'off' } }, 'agenda')).toBe(true);
    // everything else keeps today's rule: on unless its own line says off
    expect(pluginsYamlSaysOn(undefined, 'voice')).toBe(true);
    expect(pluginsYamlSaysOn({ plugins: { voice: 'off' } }, 'voice')).toBe(false);
  });

  test('turning `work` on is a held loosening; turning it off, or leaving it, is not', async () => {
    const { PluginsConfig } = await import('../../../plugin.ts');
    expect(PluginsConfig.loosens(undefined, { work: 'on', plugins: {} })).toEqual([
      'turns work on (Board and Agenda start)',
    ]);
    expect(PluginsConfig.loosens({ plugins: {} }, { work: 'on', plugins: {} })).toHaveLength(1);
    expect(PluginsConfig.loosens({ work: 'off', plugins: {} }, { work: 'on', plugins: {} })).toHaveLength(1);
    expect(PluginsConfig.loosens({ work: 'on', plugins: {} }, { work: 'on', plugins: {} })).toEqual([]);
    expect(PluginsConfig.loosens({ work: 'on', plugins: {} }, { work: 'off', plugins: {} })).toEqual([]);
    expect(PluginsConfig.loosens({ work: 'on', plugins: {} }, { plugins: {} })).toEqual([]);
  });
});

describe('RR R247 HostOptions.timings on a real boot', () => {
  test('R247 the timings fyd parsed reach every daemon half as kernel.timings', async () => {
    const home = await freshHome();
    let idleDayMs = 0;
    const access = implementDaemon(
      definePlugin({ id: 'idle', title: 'Idle', version: '5.0.0', api: 5, core: false, kinds: [] }),
      {
        build: ctx => {
          idleDayMs = ctx.kernel.timings.idleDayMs;
          return {};
        },
      },
    );
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [access],
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
      timings: { lease: { leaseMs: 6_000, renewLeadMs: 2_000, maxSessionMs: 20_000 }, idleDayMs: 5_000 },
    });
    if (outcome.kind === 'refused') throw new Error(outcome.sentence);
    running.push(outcome.host);
    expect(idleDayMs).toBe(5_000);
  });
});

describe('state/kernel/plugins-accepted.json (§2.4): the last enabled set the daemon accepted', () => {
  test('a resolved boot records its set (format 1, 0600); a plugins.yaml that strands a plugin boots that set and names the line', async () => {
    const home = await freshHome();
    await (await boot(home)).stop();
    running.splice(0);
    const accepted = JSON.parse(await readFile(`${home}/state/kernel/plugins-accepted.json`, 'utf8')) as {
      format: number;
      enabled: string[];
    };
    expect(accepted.format).toBe(1);
    expect(accepted.enabled).toContain('board');
    expect(accepted.enabled).toContain('agenda');
    expect((await stat(`${home}/state/kernel/plugins-accepted.json`)).mode & 0o777).toBe(0o600);
    // Agenda needs Board: turning Board off by hand strands Agenda, so the accepted set is kept
    await writeFile(`${home}/config/plugins.yaml`, 'work: on\nplugins:\n  board: off\n');
    const host = await boot(home);
    expect(host.plugins.get('board')?.status).toBe('serving');
    expect(host.plugins.get('agenda')?.status).toBe('serving');
    const note = (await host.doctor()).find(line => line.plugin === 'kernel' && line.detail.includes('plugins.yaml'));
    expect(note?.state).toBe('warn');
    expect(note?.detail).toContain('line 3');
    expect(note?.detail).toContain('Board');
  });

  test('a plugins.yaml that strands nothing is accepted and recorded', async () => {
    const home = await freshHome();
    await (await boot(home)).stop();
    running.splice(0);
    await writeFile(`${home}/config/plugins.yaml`, 'plugins:\n  voice: off\n');
    const host = await boot(home);
    expect(host.plugins.get('voice')?.status).toBe('off');
    const accepted = JSON.parse(await readFile(`${home}/state/kernel/plugins-accepted.json`, 'utf8')) as {
      enabled: string[];
    };
    expect(accepted.enabled).not.toContain('voice');
  });
});
