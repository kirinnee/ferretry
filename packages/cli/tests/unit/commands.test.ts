import { describe, it } from 'bun:test';
import { definePort } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import should from 'should';
import { ASK_ROUTES, askRows } from '../../src/lib/commands/ask.ts';
import { diagnose, renderFindings } from '../../src/lib/commands/doctor.ts';
import { compiledWords, findWords } from '../../src/lib/commands/words.ts';
import type { DaemonController } from '../../src/lib/daemon/controller.ts';
import { runFy } from '../../src/lib/run.ts';
import { boardEntry, fakeWorld, inventoryOf, RecordingTransport, registryOf, skeletonEntry } from './fakes.ts';
import { route } from '@ferretry/kernel/manifest';

const up = { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } } as const;
const down = { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'refused' } as const;

describe('fy plugin', () => {
  it('should list code plugins with state, contract agreement and who needs them, and daemon-only data plugins', async () => {
    const { world, io } = fakeWorld({
      registry: registryOf(boardEntry()),
      inventory: inventoryOf({ id: 'board', contract: 'other' }, { id: 'tiny', contract: 'x' }),
    });
    should(await runFy(['plugin', 'list'], world)).equal(0);
    const text = io.stdout();
    should(text).match(/board\s+code\s+on\s+5\.0\.0\s+differs\s+3 verbs, 2 routes, 2 tools/u);
    should(text).match(/tiny\s+data\s+on\s+-\s+daemon only/u);
  });

  it('should show one plugin in words, and a data plugin as the daemon’s', async () => {
    const { world, io } = fakeWorld({
      registry: registryOf(boardEntry()),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }, { id: 'tiny', contract: 'x' }),
    });
    should(await runFy(['plugin', 'show', 'board'], world)).equal(0);
    should(io.stdout()).containEql('Board (board) 5.0.0  code plugin, on');
    should(io.stdout()).containEql('verbs     card show, card move, board');
    should(await runFy(['plugin', 'show', 'tiny'], world)).equal(0);
    should(io.stdout()).containEql('tiny  data plugin, on');
  });

  it('should refuse to show a plugin nobody has, and to name none', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(boardEntry()), inventory: inventoryOf() });
    should(await runFy(['plugin', 'show', 'ghost'], world)).equal(1);
    should(io.stderr()).containEql('no plugin "ghost"');
    should(await runFy(['plugin', 'show'], world)).equal(2);
  });

  const A = definePort<{ a(): void }>('a');
  const dependency = () => {
    const base = definePlugin({
      id: 'base',
      title: 'Base',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      provides: { a: A },
    });
    const top = definePlugin({
      id: 'top',
      title: 'Top',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      needs: { a: A },
    });
    return registryOf(skeletonEntry(base, 'b'), skeletonEntry(top, 't'));
  };

  it('should refuse to turn a plugin off while a running plugin needs it, naming the dependents and the flag', async () => {
    const { world, io } = fakeWorld({
      registry: dependency(),
      inventory: inventoryOf({ id: 'base', contract: 'b' }, { id: 'top', contract: 't' }),
    });
    should(await runFy(['plugin', 'off', 'base'], world)).equal(1);
    should(io.stderr()).containEql('needed by top');
    should(io.stderr()).containEql('--with-dependents');
  });

  it('should, once confirmed, say the write is not built yet instead of pretending', async () => {
    const { world, io } = fakeWorld({
      registry: dependency(),
      inventory: inventoryOf({ id: 'base', contract: 'b' }, { id: 'top', contract: 't' }),
    });
    should(await runFy(['plugin', 'off', 'base', '--with-dependents'], world)).equal(69);
    should(io.stderr()).containEql('not built yet');
  });

  it('should refuse to turn a plugin on while what it needs is off, and a core piece either way', async () => {
    const { world, io } = fakeWorld({
      registry: dependency(),
      inventory: inventoryOf({ id: 'base', on: false, contract: 'b' }, { id: 'top', on: false, contract: 't' }),
    });
    should(await runFy(['plugin', 'on', 'top'], world)).equal(1);
    should(io.stderr()).containEql('needs base');
    const core = definePlugin({ id: 'gate', title: 'Gate', version: '5.0.0', api: 5, core: true, kinds: [] });
    const coreWorld = fakeWorld({
      registry: registryOf(skeletonEntry(core)),
      inventory: inventoryOf({ id: 'gate', contract: 'g' }),
    });
    should(await runFy(['plugin', 'off', 'gate'], coreWorld.world)).equal(1);
    should(coreWorld.io.stderr()).containEql('core piece');
  });

  it('should say the data-plugin verbs are not built yet', async () => {
    const { world, io } = fakeWorld();
    should(await runFy(['plugin', 'add', './x'], world)).equal(69);
    should(io.stderr()).containEql('data plugins is not built yet');
  });
});

describe('fy words', () => {
  const registry = registryOf(boardEntry());

  it('should find a word, or the word it replaced', () => {
    const words = compiledWords(registry);
    should(findWords(words, 'card').map(word => word.word)).deepEqual(['card']);
    should(findWords(words, 'Task').map(word => word.word)).deepEqual(['card']);
    should(findWords(words, 'nothing')).deepEqual([]);
  });

  it('should print the compiled words with a note when the daemon is away', async () => {
    const { world, io } = fakeWorld({ registry, probe: down });
    should(await runFy(['words', 'task'], world)).equal(0);
    should(io.stdout()).match(/card\s+Board\s+a unit of work on the board\s+task/u);
    should(io.stderr()).containEql('compiled into this fy');
  });

  it('should prefer the daemon’s glossary, data plugins’ words included', async () => {
    const fake = fakeWorld({ registry });
    fake.transport.replies.push({
      status: 200,
      body: { words: [{ word: 'sitrep', means: 'a ferret report', insteadOf: ['status'], plugin: 'tiny' }] },
    });
    should(await runFy(['words', 'status'], fake.world)).equal(0);
    should(fake.io.stdout()).containEql('sitrep');
    should(fake.io.stderr()).equal('');
  });

  it('should fall back to the compiled words when the daemon’s glossary cannot be read', async () => {
    const fake = fakeWorld({ registry });
    fake.transport.replies.push(new Error('connection dropped'));
    should(await runFy(['words', 'task'], fake.world)).equal(0);
    should(fake.io.stdout()).containEql('Board');
    should(fake.io.stderr()).containEql('compiled into this fy');
  });

  it('should read the glossary through the guard, and send nothing but the inventory read to a daemon whose Kernel differs', async () => {
    // Arrange
    let inventoryReads = 0;
    const fake = fakeWorld({
      registry,
      readInventory: async () => {
        inventoryReads += 1;
        return inventoryOf({ id: 'kernel', contract: 'another-kernel' });
      },
    });

    // Act
    const code = await runFy(['words', 'task'], fake.world);

    // Assert
    should(code).equal(0);
    should(inventoryReads).be.above(0);
    should(fake.transport.sent).deepEqual([]);
    should(fake.io.stdout()).containEql('Board');
    should(fake.io.stderr()).containEql('compiled into this fy');
  });

  it('should send the glossary read as the Kernel’s route once the inventory agrees', async () => {
    const fake = fakeWorld({ registry });
    await runFy(['words'], fake.world);
    should(fake.transport.sent).deepEqual([{ method: 'GET', path: '/v1/glossary' }]);
  });

  it('should say the glossary is empty when nothing declares a word', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(), probe: down });
    should(await runFy(['words'], world)).equal(0);
    should(io.stdout()).equal('the glossary is empty\n');
  });

  it('should exit 1 for a word nobody owns', async () => {
    const { world, io } = fakeWorld({ registry, probe: down });
    should(await runFy(['words', 'zzz'], world)).equal(1);
    should(io.stderr()).containEql('no word "zzz"');
  });
});

describe('fy doctor', () => {
  const base = {
    binary: 'fy',
    probe: up,
    inventory: inventoryOf({ id: 'board', contract: 'h' }),
    registry: [{ id: 'board', contract: 'h' }],
    titles: { board: 'Board' },
    halves: [{ id: 'board', title: 'Board', skeleton: false }],
    conflicts: [],
    environment: {},
  } as const;

  it('should pass when everything agrees', () => {
    const findings = diagnose(base);
    should(findings.every(finding => finding.state === 'ok')).be.true();
  });

  it('should fail with the fix when the daemon is away', () => {
    const findings = diagnose({ ...base, probe: down, inventory: { unreadable: 'x' } });
    should(findings[0]).match({ state: 'fail', title: 'daemon', fix: 'fy daemon start' });
  });

  it('should fail on a protocol mismatch and on a plugin whose contract differs, warn on one turned off', () => {
    const mismatched = diagnose({ ...base, probe: { ...up, health: { protocol: 2, version: '9' } } as never });
    should(mismatched.find(finding => finding.title === 'session protocol')?.state).equal('fail');
    const different = diagnose({ ...base, inventory: inventoryOf({ id: 'board', contract: 'other' }) });
    should(different.find(finding => finding.title === 'plugin board')?.state).equal('fail');
    const off = diagnose({ ...base, inventory: inventoryOf({ id: 'board', on: false, contract: 'h' }) });
    should(off.find(finding => finding.title === 'plugin board')?.state).equal('warn');
  });

  it('should name skeleton halves, halves that will not load, verb conflicts and daemon-only plugins', () => {
    const findings = diagnose({
      ...base,
      inventory: inventoryOf({ id: 'board', contract: 'h' }, { id: 'tiny', contract: 'x' }),
      halves: [
        { id: 'board', title: 'Board', skeleton: true },
        { id: 'bad', title: 'Bad', skeleton: false, error: 'boom' },
      ],
      conflicts: [{ line: 'doctor', owner: 'clash', keptFrom: 'shell' }],
    });
    const titles = findings.map(finding => finding.title);
    should(titles).containEql('not built yet');
    should(titles).containEql('bad commands');
    should(titles).containEql('verb conflict');
    should(titles).containEql('daemon-only plugins');
  });

  it('should warn, not fail, when the daemon answers but its plugin list cannot be read', () => {
    const findings = diagnose({ ...base, inventory: { unreadable: 'refused' } });
    should(findings.find(finding => finding.title === 'plugins')).match({
      state: 'warn',
      detail: 'the plugin list could not be read: refused',
    });
  });

  it('S60 should warn about FY_TOKEN in a pane', () => {
    const findings = diagnose({ ...base, environment: { FY_SESSION_ID: 's', FY_TOKEN: 'x' } });
    should(findings.find(finding => finding.title === 'credential')?.state).equal('warn');
  });

  it('should render a fix under a failing line, and exit 1 only when something failed', async () => {
    should(renderFindings(diagnose({ ...base, probe: down, inventory: { unreadable: 'x' } }))).containEql(
      '      fix: fy daemon start',
    );
    const healthy = fakeWorld({
      registry: registryOf(boardEntry()),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
    });
    should(await runFy(['doctor'], healthy.world)).equal(0);
    const broken = fakeWorld({ registry: registryOf(boardEntry()), probe: down });
    should(await runFy(['doctor'], broken.world)).equal(1);
  });

  describe('the daemon’s own host checks (GET /v1/doctor)', () => {
    const check = (over: Record<string, unknown>) => ({
      name: 'git',
      requirement: 'required',
      status: 'present',
      summary: 'git is on PATH',
      impact: 'no repository work without it',
      ...over,
    });
    const report = (checks: unknown[], ready = true) => ({ checks, harnesses: [], ready, limitation: 'presence only' });
    const healthyWorld = (body: unknown) => {
      const transport = new RecordingTransport();
      transport.replies.push({ status: 200, body });
      return fakeWorld({
        registry: registryOf(boardEntry()),
        inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
        transport,
      });
    };

    it('should exit 1 when a required host check is missing, and say the fix', async () => {
      const { world, io, transport } = healthyWorld(
        report([check({ status: 'missing', summary: 'git is not on PATH' })], false),
      );
      should(await runFy(['doctor'], world)).equal(1);
      should(transport.sent.map(request => request.path)).containEql('/v1/doctor');
      should(io.stdout()).containEql('FAIL  host git: git is not on PATH');
      should(io.stdout()).containEql('fix: no repository work without it');
    });

    it('should exit 0 when every host check is present', async () => {
      const { world, io } = healthyWorld(report([check({}), check({ name: 'gh', requirement: 'optional' })]));
      should(await runFy(['doctor'], world)).equal(0);
      should(io.stdout()).containEql('ok    host git');
    });

    it('should only warn for a missing optional check, and fail when the daemon says it is not ready', async () => {
      const optional = healthyWorld(report([check({ requirement: 'optional', status: 'missing' })]));
      should(await runFy(['doctor'], optional.world)).equal(0);
      should(optional.io.stdout()).containEql('warn  host git');
      const notReady = healthyWorld(report([], false));
      should(await runFy(['doctor'], notReady.world)).equal(1);
      should(notReady.io.stdout()).containEql('FAIL  host checks: the daemon reports it is not ready');
    });

    it('should list the not-yet-built checks on ONE line by name, and keep every real warn and fail on its own line', async () => {
      // Arrange
      const unbuilt = (name: string) =>
        check({
          name: `plugin: ${name}`,
          requirement: 'optional',
          status: 'missing',
          summary: `The check ${name} is not built yet in this build, so nothing was checked.`,
          impact: 'Ferretry keeps working, with less than it could do.',
        });
      const { world, io } = healthyWorld(
        report(
          [
            unbuilt('chrome'),
            check({}),
            unbuilt('board-store'),
            check({ name: 'gh', requirement: 'optional', status: 'missing', summary: 'gh is not on PATH' }),
            unbuilt('agenda-buzz'),
            check({ name: 'tmux', status: 'missing', summary: 'tmux is not on PATH' }),
          ],
          false,
        ),
      );

      // Act
      const code = await runFy(['doctor'], world);

      // Assert
      const lines = io.stdout().split('\n');
      should(lines.filter(line => line.includes('Not built yet in this build'))).deepEqual([
        'warn  Not built yet in this build (nothing checked): agenda-buzz, board-store, chrome',
      ]);
      should(lines.filter(line => line.includes('so nothing was checked'))).be.empty();
      should(io.stdout()).not.containEql('host plugin: chrome');
      should(lines).containEql('warn  host gh: gh is not on PATH');
      should(lines).containEql('FAIL  host tmux: tmux is not on PATH');
      should(lines).containEql('ok    host git: git is on PATH');
      should(code).equal(1);
    });

    it('should still exit 0 with ready true when the only warnings are not-yet-built checks', async () => {
      const { world, io } = healthyWorld(
        report([
          check({
            name: 'plugin: chrome',
            requirement: 'optional',
            status: 'missing',
            summary: 'The check chrome is not built yet in this build, so nothing was checked.',
          }),
        ]),
      );
      should(await runFy(['doctor'], world)).equal(0);
      should(io.stdout()).containEql('warn  Not built yet in this build (nothing checked): chrome');
    });

    it('should warn, not fail, when the report is refused or not readable', async () => {
      const refused = healthyWorld({ error: 'no' });
      refused.transport.replies[0] = { status: 403, body: { error: 'not allowed' } };
      should(await runFy(['doctor'], refused.world)).equal(0);
      should(refused.io.stdout()).containEql('warn  host checks: host checks could not be read');
      const shapeless = healthyWorld({ nonsense: true });
      should(await runFy(['doctor'], shapeless.world)).equal(0);
      should(shapeless.io.stdout()).containEql('warn  host checks');
    });

    it('should not ask for the report when the daemon is away', async () => {
      const transport = new RecordingTransport();
      const { world } = fakeWorld({ registry: registryOf(boardEntry()), probe: down, transport });
      await runFy(['doctor'], world);
      should(transport.sent).be.empty();
    });
  });

  it('should keep going when the plugin list cannot be read or a half will not load', async () => {
    // Arrange
    const unloadable = { ...boardEntry(), load: async () => Promise.reject(new Error('cannot load')) };
    const unreadable = fakeWorld({
      registry: registryOf(unloadable),
      readInventory: async () => Promise.reject(new Error('list refused')),
    });
    const notAnError = fakeWorld({
      registry: registryOf(boardEntry()),
      readInventory: async () => Promise.reject('plain text' as never),
    });

    // Act
    const code = await runFy(['doctor'], unreadable.world);
    await runFy(['doctor'], notAnError.world);

    // Assert
    should(code).equal(1);
    should(unreadable.io.stdout()).containEql('list refused');
    should(unreadable.io.stdout()).containEql('cannot load');
    should(notAnError.io.stdout()).containEql('plain text');
  });
});

describe('fy daemon', () => {
  it('should report a running daemon with its build and whether the plugins agree', async () => {
    const { world, io } = fakeWorld({
      registry: registryOf(boardEntry()),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
    });
    should(await runFy(['daemon', 'status'], world)).equal(0);
    should(io.stdout()).containEql('version  5.0.0');
    should(io.stdout()).containEql('every plugin of this fy agrees with the daemon');
  });

  it('should point at the restart when a plugin differs', async () => {
    const { world, io } = fakeWorld({
      registry: registryOf(boardEntry()),
      inventory: inventoryOf({ id: 'board', contract: 'other' }),
    });
    await runFy(['daemon', 'status'], world);
    should(io.stdout()).containEql('board differ or are missing: restart the daemon with `fy daemon restart`');
  });

  it('should still report the daemon when its plugin list cannot be read', async () => {
    const error = fakeWorld({ readInventory: async () => Promise.reject(new Error('list refused')) });
    should(await runFy(['daemon', 'status'], error.world)).equal(0);
    should(error.io.stdout()).containEql('plugins  not read: list refused');
    const text = fakeWorld({ readInventory: async () => Promise.reject('plain text' as never) });
    await runFy(['daemon', 'status'], text.world);
    should(text.io.stdout()).containEql('plugins  not read: plain text');
  });

  it('should exit 1 when the daemon is not running, naming the start command', async () => {
    const { world, io } = fakeWorld({ probe: down });
    should(await runFy(['daemon', 'status'], world)).equal(1);
    should(io.stderr()).containEql('fy daemon start');
  });

  it('should start the daemon, or say why not, or note it is already up', async () => {
    const started = fakeWorld({ probe: down, launch: { started: true, baseUrl: 'http://127.0.0.1:7431' } });
    should(await runFy(['daemon', 'start'], started.world)).equal(0);
    const failed = fakeWorld({ probe: down, launch: { started: false, why: 'no fyd' } });
    should(await runFy(['daemon', 'start'], failed.world)).equal(1);
    should(failed.io.stderr()).equal('no fyd\n');
    const already = fakeWorld();
    should(await runFy(['daemon', 'start'], already.world)).equal(0);
    should(already.io.stdout()).containEql('already running');
  });

  it('V-0244 V-0237 should run stop and restart on the controller of the world, and pass --when-idle', async () => {
    const { world } = fakeWorld();
    const calls: string[] = [];
    const controller = {
      stop: async () => void calls.push('stop'),
      restart: async (options: unknown) => void calls.push(`restart ${JSON.stringify(options)}`),
    } as unknown as DaemonController;
    let code = 0;
    const wired = { ...world, daemon: () => ({ controller, exitCode: () => code }) };
    should(await runFy(['daemon', 'stop'], wired)).equal(0);
    should(await runFy(['daemon', 'restart'], wired)).equal(0);
    should(await runFy(['daemon', 'restart', '--when-idle'], wired)).equal(0);
    code = 3;
    should(await runFy(['daemon', 'stop'], wired)).equal(3);
    should(calls).deepEqual(['stop', 'restart {}', 'restart {"whenIdle":true}', 'stop']);
  });

  it('V-0236 V-0233 V-0249 V-0234 V-0251 should route reset, install, uninstall, logs and which, with their flags', async () => {
    const { world } = fakeWorld();
    const calls: string[] = [];
    const record = (name: string) => async (options?: unknown) =>
      void calls.push(`${name} ${JSON.stringify(options ?? {})}`);
    const controller = {
      reset: record('reset'),
      install: record('install'),
      uninstall: record('uninstall'),
      logs: record('logs'),
      which: record('which'),
    } as unknown as DaemonController;
    const wired = { ...world, daemon: () => ({ controller, exitCode: () => 0 }) };
    for (const words of [
      ['daemon', 'reset', '--yes'],
      ['daemon', 'reset', '-y'],
      ['daemon', 'reset'],
      ['daemon', 'install'],
      ['daemon', 'uninstall'],
      ['daemon', 'logs', '-f'],
      ['daemon', 'logs'],
      ['daemon', 'which', '--json'],
    ])
      should(await runFy(words, wired)).equal(0);
    should(calls).deepEqual([
      'reset {"yes":true}',
      'reset {"yes":true}',
      'reset {"yes":false}',
      'install {}',
      'uninstall {}',
      'logs {"follow":true}',
      'logs {"follow":false}',
      'which {"json":true}',
    ]);
  });

  it('should say a world without daemon-control adapters has none, rather than pretending', async () => {
    const { world, io } = fakeWorld();
    should(await runFy(['daemon', 'stop'], world)).equal(69);
    should(io.stderr()).containEql('no local daemon-control adapters');
  });
});

describe('fy ask', () => {
  const asksManifest = definePlugin({
    id: 'asks',
    title: 'Asks',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    actions: {
      routes: [
        route(ASK_ROUTES.list, {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'read' },
          guard: { none: 'ids' },
        }),
        route(ASK_ROUTES.show, {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'read' },
          guard: { none: 'ids' },
        }),
        route(ASK_ROUTES.answer, {
          minimum: 'authenticated',
          caller: 'person',
          audit: { skip: 'test' },
          guard: { none: 'ids' },
        }),
      ],
    },
  });
  const withAsks = () => {
    const fake = fakeWorld({
      registry: registryOf(skeletonEntry(asksManifest, 'h-asks')),
      inventory: inventoryOf({ id: 'asks', contract: 'h-asks' }),
    });
    return fake;
  };

  it('should say Asks is not built yet while it declares no routes', async () => {
    const { world, io } = fakeWorld();
    should(await runFy(['ask'], world)).equal(69);
    should(io.stderr()).containEql('Asks is not built yet');
  });

  it('should list the asks waiting, or say none are', async () => {
    const { world, io, transport } = withAsks();
    transport.replies.push({ status: 200, body: { asks: [{ id: 'a1', source: 'board', title: 'Move c1?' }] } });
    should(await runFy(['ask'], world)).equal(0);
    should(io.stdout()).match(/a1\s+board\s+Move c1\?/u);
    transport.replies.push({ status: 200, body: [] });
    await runFy(['ask', 'list'], world);
    should(io.stdout()).containEql('no asks are waiting');
  });

  it('should answer an ask with the text, and show one', async () => {
    const { world, io, transport } = withAsks();
    should(await runFy(['ask', 'answer', 'a1', 'yes', 'please'], world)).equal(0);
    should(transport.sent).deepEqual([{ method: 'POST', path: '/v1/asks/a1/answer', body: { answer: 'yes please' } }]);
    should(io.stdout()).containEql('answered a1');
    transport.replies.push({ status: 200, body: { id: 'a1' } });
    should(await runFy(['ask', 'show', 'a1'], world)).equal(0);
  });

  it('S59 a person-only shell route from a pane is refused before any connection is opened', async () => {
    // Arrange
    const { world, io, connects, transport } = fakeWorld({
      registry: registryOf(skeletonEntry(asksManifest, 'h-asks')),
      inventory: inventoryOf({ id: 'asks', contract: 'h-asks' }),
      environment: { FY_SESSION_ID: 's1' },
    });

    // Act
    const code = await runFy(['ask', 'answer', 'a1', 'yes'], world);

    // Assert
    should(code).equal(1);
    should(io.stderr()).containEql("this is the owner's command; a ferret's pane can't run it");
    should(connects).deepEqual([]);
    should(transport.sent).deepEqual([]);
  });

  it('S59 an open shell route from a pane still connects and is sent', async () => {
    const { world, connects, transport } = fakeWorld({
      registry: registryOf(skeletonEntry(asksManifest, 'h-asks')),
      inventory: inventoryOf({ id: 'asks', contract: 'h-asks' }),
      environment: { FY_SESSION_ID: 's1' },
    });
    transport.replies.push({ status: 200, body: [] });
    should(await runFy(['ask', 'list'], world)).equal(0);
    should(connects).have.length(1);
    should(transport.sent).deepEqual([{ method: 'GET', path: '/v1/asks' }]);
  });

  it('should refuse an answer without an id and text, and an unknown subcommand', async () => {
    const { world } = withAsks();
    should(await runFy(['ask', 'answer', 'a1'], world)).equal(2);
    should(await runFy(['ask', 'show'], world)).equal(2);
    should(await runFy(['ask', 'zap'], world)).equal(2);
  });

  it('should read a list shape it does not know as an error, not a crash', () => {
    should(() => askRows({ nope: true })).throw(/shape this fy does not read/u);
  });
});
