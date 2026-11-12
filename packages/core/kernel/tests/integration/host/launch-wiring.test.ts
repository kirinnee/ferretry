import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FerretConfigFile, LaunchParts, Runners, type RunSpec } from '../../../../ferrets/contract/index.ts';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { fakeLoginChanges, fakeLogins } from '../../../../../plugins/logins/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { diskFolders, type TestHost, testHost } from '../../../testing/index.ts';

/**
 * #1587 through the daemon, on the path production takes: the REAL Ferrets, Runtimes and Claude Code halves, as the
 * generated registry builds them. Every start, restart/revive and adoption goes `FerretsService.launchAttempt` ->
 * `ClaudeHarness.launch` -> the runner; the table drives that and nothing else.
 *
 *  (i)   a folder whose `.claude/settings*.json` sets a key the login leaves to the process environment is refused,
 *        naming the file and the key, and nothing is launched;
 *  (ii)  a symlinked `.git`, an unverified worktree back-link and a missing folder are refused;
 *  (iii) the login's credential never appears in the runner's argv, and rides only the harness's private settings file;
 *  (iv)  a clean folder launches;
 *  (v)   the login's pinned literal environment is in the `--settings` file, which outranks a folder's own `env`.
 *
 * (vi)  the login's pins are never lost AFTER the folder was judged: the facts are read once, so a `fixed.json` that breaks
 *       after the decision still launches with the pins that were checked, and one already broken refuses the launch;
 * (vii) `fast: true` writes `fastMode` and a published account `compactAt` writes `autoCompactWindow`, on a start, a
 *       stop/resume and an adoption alike, into the same private settings file.
 *
 * A MOVE is the fifth path. Its route (`POST /v1/ferrets/:id/move`) is still a 503 skeleton on this base (its account
 * inventory, planner and session directory are unbound): with a request id and a COMPLETE legacy lifecycle record it
 * reaches the unbound account-resolution dependency (`503 plugin_unavailable`) and launches nothing; a freshly started
 * record has no lifecycle command, so it answers `409 session_unusable` first. Both are pinned here so the day the
 * route is bound it must go through `launchAttempt` too.
 *
 * Fixture values only; folders are real temporary directories because the folder settings are read from disk.
 */

/**
 * Fault injection at the launch itself: a test plugin that contributes a `launch.parts` source, which Ferrets asks once
 * per launch AFTER `start.decide` has judged it. `atLaunch` is called with the 1-based launch count the moment it is
 * asked, so a test can break a file exactly `after the decision` (a source that touched the files first would meet the
 * damage; one that reads nothing again cannot). Fixture-only; unset outside the tests that use it.
 */
let atLaunch: ((launch: number) => void) | undefined;
let launchesAsked = 0;

const faultPlugin = () =>
  implementDaemon(
    definePlugin({
      id: 'fault-injection',
      title: 'Fault injection (fixture)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: LaunchParts }] },
    }),
    {
      build: () => ({
        hooks: {
          'launch.parts': () => [
            {
              id: 'fault',
              item: {
                parts: async () => {
                  launchesAsked += 1;
                  atLaunch?.(launchesAsked);
                  return [];
                },
              },
            },
          ],
        },
      }),
    },
  );

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/** A runner that keeps what it was asked to run. */
class RecordingRunner extends FakeRunner {
  readonly specs: RunSpec[] = [];
  override async start(spec: RunSpec) {
    this.specs.push(spec);
    return await super.start(spec);
  }
}

const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

const ID = '00000000-0000-4000-8000-0000000000a1';
const HOME = `/fleet/homes/${ID}`;
const RUNTIME = 'work';
/** A literal credential in a login's YAML (an internal gateway's token): pinned, so it must never ride an argv. */
const TOKEN = 'fixture-gateway-token-0001';
const BASE_URL = 'https://gateway.fixture.invalid';

/** The fleet one apply publishes: a Claude runtime whose login pins two literals and leaves one key to the secret store. */
const manifest = {
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      id: ID,
      kind: 'claude',
      mode: 'auto',
      wrapper: '/fleet/bin/claude-work',
      home: HOME,
      displayName: 'Work',
      defaultModel: 'm',
      models: [{ id: 'm', displayName: 'M', available: true }],
      available: true,
      unavailableReason: null,
      secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
    },
  ],
  runtimes: [
    {
      id: ID,
      name: RUNTIME,
      harness: 'claude',
      credential: 'c',
      profile: 'p',
      agent: true,
      wrapper: '/fleet/bin/claude-work',
      models: [],
      defaultModel: null,
    },
  ],
};
const FIXED = JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN } });

let fixture: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'launch-wiring-'));
  atLaunch = undefined;
  startExtras = {};
  launchesAsked = 0;
});
afterEach(async () => {
  atLaunch = undefined;
  await rm(fixture, { recursive: true, force: true });
});

async function boot(runner: RecordingRunner, fixed: string | null = FIXED): Promise<TestHost> {
  const h = await testHost({
    everyDirectory: true,
    // The launch folder's settings are read through the kernel's own `harness-home` rules, here over real temp files.
    harnessHomeFolders: await diskFolders(await mkdtemp(join(fixture, 'roots-'))),
    plugins: [real('ferrets'), real('runtimes'), real('claude-code'), runnerPlugin(runner), faultPlugin()],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks: new FakeAsks(),
      logins: fakeLogins(),
      loginChanges: fakeLoginChanges(),
    },
    // `claude` exists and answers its version, so the harness is discovered.
    executables: ['/opt/bin/claude'],
    searchPath: '/opt/bin',
    spawn: (program: string) =>
      ({
        exitCode: 0,
        signal: null,
        stdout: program === 'which' ? '/opt/bin/claude\n' : '2.1.220 (Claude Code)\n',
        stderr: '',
      }) as never,
  });
  h.putRoot('fleet', 'manifest.json', JSON.stringify(manifest));
  if (fixed !== null) h.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, fixed);
  return h;
}

/** Start options every start of the current test adds (a ferret's own compaction choice rides the start, like v4's). */
let startExtras: Record<string, unknown> = {};

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { mode: 'interactive', runtime: RUNTIME, harness: 'claude-code', ...startExtras, ...body },
  });
const idOf = (answer: { json<T>(): T }) => answer.json<{ id: string }>().id;

/** The settings file the harness wrote into the ferret's own home, which `--settings` names. */
const overlayOf = (h: TestHost, id: string): { env?: Record<string, string> } | undefined => {
  const text = h.rootText('agent-homes', `${id}/launch-settings.json`);
  return text === undefined ? undefined : (JSON.parse(text) as { env?: Record<string, string> });
};

/** What a case does to the launch folder; a clean folder is the folder as `folder()` makes it. */
type Plant = (directory: string) => Promise<void>;

/** A fresh, clean folder (its own `.claude`). */
const folder = async (name: string): Promise<string> => {
  const path = join(fixture, name);
  await mkdir(join(path, '.claude'), { recursive: true });
  return path;
};

const settings =
  (file: string, env: Record<string, string>): Plant =>
  async directory => {
    await writeFile(join(directory, '.claude', file), JSON.stringify({ env }));
  };

interface Outcome {
  readonly status: number;
  readonly body: string;
  /** Launches this drive made. */
  readonly launches: number;
  /** The ferret the drive launched, when it did. */
  readonly ferret?: string;
}

/** One way a launch happens, driven through the real service. `plant` is applied to the folder the launch is judged in. */
interface Row {
  readonly name: string;
  readonly drive: (h: TestHost, runner: RecordingRunner, name: string, plant: Plant) => Promise<Outcome>;
}

/** A record as a v4 session left it: it HAS its lifecycle command and tmux session, so a move can start from it. */
function plantLegacyLifecycle(h: TestHost, id: string): void {
  const state = h.state('ferrets');
  const raw = JSON.parse(state.raw(FerretConfigFile, id) as string) as Record<string, unknown>;
  state.plant(
    FerretConfigFile,
    JSON.stringify({ ...raw, command: ['/fleet/bin/claude-work'], tmuxSession: 'fixture-pane' }),
    id,
  );
}

/** A move request WITH its request id, on a record that has a complete legacy lifecycle. */
const legacyMove = async (h: TestHost, id: string) => {
  plantLegacyLifecycle(h, id);
  return await h.request('POST', `/v1/ferrets/${id}/move`, {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { agent: RUNTIME },
  });
};

const outcome = (r: { status: number; body: string }, launches: number): Outcome => ({
  status: r.status,
  body: r.body,
  launches,
  ...(r.status < 300 ? { ferret: (JSON.parse(r.body) as { id: string }).id } : {}),
});

const ADOPTED = '11111111-2222-4333-8444-555555555555';

const ROWS: readonly Row[] = [
  {
    name: 'start',
    drive: async (h, runner, name, plant) => {
      const where = await folder(name);
      await plant(where);
      const before = runner.starts;
      const started = await start(h, { folder: where });
      return outcome(started, runner.starts - before);
    },
  },
  {
    // A revive relaunches in the folder as it is NOW: what is planted after the first start is judged.
    name: 'revive',
    drive: async (h, runner, name, plant) => {
      const where = await folder(name);
      const first = await start(h, { folder: where });
      expect(first.status).toBe(201);
      await h.settle();
      const id = idOf(first);
      expect(
        (await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} })).status,
      ).toBeLessThan(300);
      await h.settle();
      await plant(where);
      const before = runner.starts;
      const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });
      return { status: resumed.status, body: resumed.body, launches: runner.starts - before, ferret: id };
    },
  },
  {
    // An adoption starts a ferret INTO a conversation that already exists: the harness resumes it.
    name: 'adopt',
    drive: async (h, runner, name, plant) => {
      const where = await folder(name);
      await plant(where);
      const before = runner.starts;
      const started = await start(h, { folder: where, harnessConversation: ADOPTED });
      return outcome(started, runner.starts - before);
    },
  },
  {
    // A move's route is a 503 skeleton on this base (its accounts, planner and session directory are unbound): it must
    // refuse before launching anything, and the day it is bound its relaunch is `launchAttempt` like the rest. The
    // request carries its id and the record a complete legacy lifecycle, so the route gets past the request check and
    // the lifecycle subject to the unbound dependency itself (see `legacyMove`).
    name: 'move',
    drive: async (h, runner, name, plant) => {
      const where = await folder(name);
      const first = await start(h, { folder: where });
      expect(first.status).toBe(201);
      await h.settle();
      await plant(where);
      const before = runner.starts;
      const moved = await legacyMove(h, idOf(first));
      return { status: moved.status, body: moved.body, launches: runner.starts - before };
    },
  },
];

/** The cases: what is wrong with the folder, and what the refusal must say. */
const REFUSED: readonly { readonly name: string; readonly plant: Plant; readonly says: readonly string[] }[] = [
  {
    name: 'settings.json sets the key the login leaves to the secret store',
    plant: settings('settings.json', { ANTHROPIC_API_KEY: '' }),
    says: ['.claude/settings.json', 'ANTHROPIC_API_KEY'],
  },
  {
    name: 'settings.local.json sets it',
    plant: settings('settings.local.json', { ANTHROPIC_API_KEY: 'x' }),
    says: ['.claude/settings.local.json', 'ANTHROPIC_API_KEY'],
  },
  {
    name: '.git is a symlink',
    plant: async directory => await symlink(join(fixture, 'elsewhere'), join(directory, '.git')),
    says: ['.git'],
  },
  {
    name: 'a worktree whose back-link cannot be proved',
    plant: async directory =>
      await writeFile(join(directory, '.git'), `gitdir: ${join(fixture, 'no-such-repo', '.git', 'worktrees', 'w')}\n`),
    says: [],
  },
  {
    name: 'the folder is gone',
    plant: async directory => await rm(directory, { recursive: true, force: true }),
    says: [],
  },
];

describe.each(ROWS.map(row => [row.name, row] as const))('#1587 launch wiring: %s', (name, row) => {
  const isMove = name === 'move';

  test.each(REFUSED.map(c => [c.name, c] as const))(
    '(i)(ii) a folder where %s is refused, and nothing is launched',
    async (_case, refused) => {
      const runner = new RecordingRunner();
      const h = await boot(runner);

      const result = await row.drive(h, runner, `refused-${randomUUID()}`, refused.plant);

      if (isMove) {
        // The skeleton refuses first, whatever the folder: the exact code, and never a launch.
        expect(result.status).toBe(503);
        expect(JSON.parse(result.body)).toMatchObject({ code: 'plugin_unavailable' });
      } else {
        expect(result.status).toBeGreaterThanOrEqual(400);
        for (const sentence of refused.says) expect(result.body).toContain(sentence);
      }
      expect(result.launches).toBe(0);
      await h.stop();
    },
  );

  test('(iii)(iv)(v) a clean folder launches; the credential is in no argv and the login’s pins are in the private settings file', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    const result = await row.drive(h, runner, `clean-${randomUUID()}`, async () => undefined);

    if (isMove) {
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body)).toMatchObject({ code: 'plugin_unavailable' });
      expect((JSON.parse(result.body) as { error: string }).error).toContain('account resolution');
      expect(result.launches).toBe(0);
      await h.stop();
      return;
    }
    expect(result.status).toBeLessThan(300);
    expect(result.launches).toBe(1);
    const spec = runner.specs.at(-1) as RunSpec;
    expect(JSON.stringify(spec.command)).not.toContain(TOKEN);
    expect(JSON.stringify(spec.command)).not.toContain('gateway.fixture');
    const home = (spec.command.find(part => part.startsWith('CLAUDE_CONFIG_DIR=')) as string).slice(
      'CLAUDE_CONFIG_DIR='.length,
    );
    // The argv names the settings file's path, never its content.
    expect(spec.command).toContain(`${home}/launch-settings.json`);
    expect(overlayOf(h, result.ferret as string)?.env).toEqual({
      ANTHROPIC_BASE_URL: BASE_URL,
      ANTHROPIC_AUTH_TOKEN: TOKEN,
    });
    await h.stop();
  });
});

describe('#1587 what is not judged', () => {
  test('a start on no runtime launches without the fleet being consulted or any pin written', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    const where = await folder('norun');
    await settings('settings.local.json', { ANTHROPIC_API_KEY: '' })(where);

    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { mode: 'interactive', harness: 'claude-code', folder: where },
    });

    expect(started.status).toBe(201);
    expect(overlayOf(h, idOf(started))?.env).toBeUndefined();
    await h.stop();
  });
});

/** The rows that really launch (a move is a skeleton on this base). */
const LAUNCHING = ROWS.filter(row => row.name !== 'move');
const PINS = { ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN };
const BROKEN_FIXED = '{ fixture-corruption';

describe.each(LAUNCHING.map(row => [row.name, row] as const))('#1587 the pins never fail open: %s', (name, row) => {
  test('a fixed.json already broken refuses the launch, and the runner is not called', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    // A revive judges the file as it is at the resume; a start and an adoption as it is at the start.
    const result = await row.drive(h, runner, `broken-${randomUUID()}`, async () => {
      h.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, BROKEN_FIXED);
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toContain('could not be read');
    expect(result.launches).toBe(0);
    await h.stop();
  });

  test('a fixed.json that breaks after the folder was judged still launches with the pins that were checked', async () => {
    // The facts are read ONCE per launch (at \`start.decide\`) and carried to the launch: nothing is read again, so the
    // launch cannot meet a half-written or broken file after the decision and carry on without the pins.
    let h: TestHost | undefined;
    // A revive's first launch is its start; the launch under test is the resume.
    const underTest = name === 'revive' ? 2 : 1;
    atLaunch = launch => {
      if (launch === underTest) h?.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, BROKEN_FIXED);
    };
    const runner = new RecordingRunner();
    h = await boot(runner);

    const result = await row.drive(h, runner, `after-${randomUUID()}`, async () => undefined);

    expect(result.status).toBeLessThan(300);
    expect(result.launches).toBe(1);
    expect(overlayOf(h, result.ferret as string)?.env).toEqual(PINS);
    expect(launchesAsked).toBe(underTest);
    await h.stop();
  });
});

/** A PRESENT fixed.json of the wrong shape is damaged evidence, never "no pins" (v4's fixedSettingsObject refused all of these). */
const WRONG_SHAPES: readonly (readonly [string, string])[] = [
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '42'],
  ['an env that is an array', '{"env":[]}'],
  ['an env that is null', '{"env":null}'],
  ['an env value that is not text', '{"env":{"ANTHROPIC_AUTH_TOKEN":42,"ANTHROPIC_BASE_URL":"fixture-literal-9931"}}'],
];

describe.each(LAUNCHING.map(row => [row.name, row] as const))(
  '#1587 a damaged fixed.json refuses: %s',
  (_name, row) => {
    test.each(WRONG_SHAPES)(
      '%s refuses the launch, names the file, shows no value, and starts nothing',
      async (_label, text) => {
        const runner = new RecordingRunner();
        const h = await boot(runner);

        const result = await row.drive(h, runner, `shape-${randomUUID()}`, async () => {
          h.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, text);
        });

        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.body).toContain('fixed.json');
        expect(result.body).not.toContain('fixture-literal-9931');
        expect(result.body).not.toContain(TOKEN);
        expect(result.launches).toBe(0);
        await h.stop();
      },
    );

    test.each([
      ['an object with no env', '{}'],
      ['an object whose env is empty', '{"env":{}}'],
      [
        'an object with other keys beside a valid env',
        '{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://gateway.fixture.invalid"}}',
      ],
    ])('%s is still the deliberate "pins what it holds" case', async (_label, text) => {
      const runner = new RecordingRunner();
      const h = await boot(runner);

      const result = await row.drive(h, runner, `shape-ok-${randomUUID()}`, async () => {
        h.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, text);
      });

      expect(result.status).toBeLessThan(300);
      expect(result.launches).toBe(1);
      await h.stop();
    });

    test('a fixed.json that is absent is a login that pins nothing: it launches, with no pin written', async () => {
      const runner = new RecordingRunner();
      const h = await boot(runner, null);

      const result = await row.drive(h, runner, `absent-${randomUUID()}`, async () => undefined);

      expect(result.status).toBeLessThan(300);
      expect(result.launches).toBe(1);
      expect(overlayOf(h, result.ferret as string)?.env).toBeUndefined();
      await h.stop();
    });
  },
);

describe.each(LAUNCHING.map(row => [row.name, row] as const))('#1587 fast mode and compaction: %s', (_name, row) => {
  const overlay = (h: TestHost, id: string) =>
    JSON.parse(h.rootText('agent-homes', `${id}/launch-settings.json`) as string) as {
      fastMode?: boolean;
      autoCompactWindow?: number;
      env?: Record<string, string>;
    };
  const publish = (h: TestHost, compactAt: unknown) =>
    h.putRoot(
      'fleet',
      'manifest.json',
      JSON.stringify({ ...manifest, accounts: [{ ...manifest.accounts[0], compactAt }] }),
    );

  test('a published account compactAt reaches the private settings file as autoCompactWindow, beside the pins', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    publish(h, 200_000);

    const result = await row.drive(h, runner, `compact-${randomUUID()}`, async () => undefined);

    expect(result.status).toBeLessThan(300);
    expect(result.launches).toBe(1);
    expect(overlay(h, result.ferret as string).autoCompactWindow).toBe(200_000);
    expect(overlay(h, result.ferret as string).env).toEqual(PINS);
    // The value rides the private file only, never the argv.
    expect(JSON.stringify(runner.specs.at(-1)?.command)).not.toContain('200000');
    await h.stop();
  });

  test('compactAt auto adds no compaction setting', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    publish(h, 'auto');

    const result = await row.drive(h, runner, `auto-${randomUUID()}`, async () => undefined);

    expect(result.status).toBeLessThan(300);
    expect(overlay(h, result.ferret as string).autoCompactWindow).toBeUndefined();
    await h.stop();
  });
});

describe.each(LAUNCHING.map(row => [row.name, row] as const))(
  '#1587 compaction keeps v4 resolveCompactAt: own value over the login default, capped by the model window: %s',
  (_name, row) => {
    const windowAt = (h: TestHost, id: string): number | undefined =>
      (JSON.parse(h.rootText('agent-homes', `${id}/launch-settings.json`) as string) as { autoCompactWindow?: number })
        .autoCompactWindow;
    /** Publishes a login whose default model `m` has this context window (absent: the catalog states none). */
    const publish = (h: TestHost, accountAt: number | 'auto', context: number | undefined) =>
      h.putRoot(
        'fleet',
        'manifest.json',
        JSON.stringify({
          ...manifest,
          accounts: [
            {
              ...manifest.accounts[0],
              compactAt: accountAt,
              defaultModel: 'm',
              models: [{ id: 'm', displayName: 'M', available: true, ...(context === undefined ? {} : { context }) }],
            },
          ],
        }),
      );
    const run = async (
      accountAt: number | 'auto',
      context: number | undefined,
      extras: Record<string, unknown> = {},
    ) => {
      startExtras = extras;
      const runner = new RecordingRunner();
      const h = await boot(runner);
      publish(h, accountAt, context);
      const result = await row.drive(h, runner, `compact-${randomUUID()}`, async () => undefined);
      expect(result.status).toBeLessThan(300);
      expect(result.launches).toBe(1);
      const at = windowAt(h, result.ferret as string);
      await h.stop();
      return at;
    };

    test.each([200_000, 1_000_000])(
      'an account compactAt of %i larger than the model’s 128000 window falls back to Auto (nothing written)',
      async accountAt => {
        expect(await run(accountAt, 128_000)).toBeUndefined();
      },
    );

    test('the same cap holds for a model the start NAMED', async () => {
      expect(await run(200_000, 128_000, { model: 'm' })).toBeUndefined();
    });

    test('a value that fits the window is written as is, and equal to the window fits', async () => {
      expect(await run(400_000, 1_000_000)).toBe(400_000);
      expect(await run(128_000, 128_000)).toBe(128_000);
    });

    test('a model whose catalog states no window is judged against the 200k default, as v4 planned it', async () => {
      expect(await run(1_000_000, undefined)).toBeUndefined();
      expect(await run(200_000, undefined)).toBe(200_000);
    });

    test('a [1m] model selector states a 1M window even when the catalog says less', async () => {
      expect(await run(400_000, 128_000, { model: 'm[1m]' })).toBe(400_000);
    });

    test('a ferret’s own value overrides the account default', async () => {
      expect(await run(200_000, 1_000_000, { compactAt: 300_000 })).toBe(300_000);
    });

    test('a ferret’s own Auto suppresses a numeric account default', async () => {
      expect(await run(200_000, 1_000_000, { compactAt: 'auto' })).toBeUndefined();
    });

    test('a ferret’s own number gives Auto when it is larger than the window; the account default is not used in its place', async () => {
      expect(await run(100_000, 128_000, { compactAt: 500_000 })).toBeUndefined();
    });

    test('a ferret’s own number applies where the account default is Auto', async () => {
      expect(await run('auto', 1_000_000, { compactAt: 250_000 })).toBe(250_000);
    });
  },
);

describe('#1587 a ferret’s own compaction choice in its session config reaches a resume', () => {
  test('config.json compactAt (what the compact-at action edits) overrides the account default on the next launch', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    h.putRoot(
      'fleet',
      'manifest.json',
      JSON.stringify({
        ...manifest,
        accounts: [
          {
            ...manifest.accounts[0],
            compactAt: 200_000,
            models: [{ id: 'm', displayName: 'M', available: true, context: 1_000_000 }],
          },
        ],
      }),
    );
    const first = await start(h, { folder: await folder('config-own') });
    expect(first.status).toBe(201);
    await h.settle();
    const id = idOf(first);
    expect(
      (await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} })).status,
    ).toBeLessThan(300);
    await h.settle();
    const state = h.state('ferrets');
    const raw = JSON.parse(state.raw(FerretConfigFile, id) as string) as Record<string, unknown>;
    state.plant(FerretConfigFile, JSON.stringify({ ...raw, compactAt: 350_000 }), id);

    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });

    expect(resumed.status).toBe(200);
    expect(
      (JSON.parse(h.rootText('agent-homes', `${id}/launch-settings.json`) as string) as { autoCompactWindow?: number })
        .autoCompactWindow,
    ).toBe(350_000);
    await h.stop();
  });
});

describe('#1587 fast mode through the production start', () => {
  const overlay = (h: TestHost, id: string) =>
    JSON.parse(h.rootText('agent-homes', `${id}/launch-settings.json`) as string) as {
      fastMode?: boolean;
      env?: Record<string, string>;
    };

  test('fast: true writes fastMode, and a stop/resume keeps it', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    const first = await start(h, { folder: await folder('fast'), fast: true });
    expect(first.status).toBe(201);
    await h.settle();
    const id = idOf(first);
    expect(overlay(h, id).fastMode).toBe(true);
    expect(overlay(h, id).env).toEqual(PINS);
    expect(
      (await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} })).status,
    ).toBeLessThan(300);
    await h.settle();
    // The overlay is rewritten at every launch: remove it so the resume has to put fastMode back.
    h.putRoot('agent-homes', `${id}/launch-settings.json`, '{}');
    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });

    expect(resumed.status).toBe(200);
    expect(overlay(h, id).fastMode).toBe(true);
    expect(overlay(h, id).env).toEqual(PINS);
    await h.stop();
  });

  test('a start that does not name fast mode leaves it to Claude', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    const started = await start(h, { folder: await folder('nofast') });

    expect(started.status).toBe(201);
    expect(overlay(h, idOf(started)).fastMode).toBeUndefined();
    await h.stop();
  });
});

describe('#1587 a move on a record a v4 session left', () => {
  test('a freshly started record has no lifecycle command, so the move answers 409 session_unusable before any launch', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    const first = await start(h, { folder: await folder('fresh-move') });
    expect(first.status).toBe(201);
    await h.settle();
    const before = runner.starts;

    const moved = await h.request('POST', `/v1/ferrets/${idOf(first)}/move`, {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { agent: RUNTIME },
    });

    expect(moved.status).toBe(409);
    expect(JSON.parse(moved.body)).toMatchObject({ code: 'session_unusable' });
    expect(runner.starts - before).toBe(0);
    await h.stop();
  });

  test('a move without its request id never reaches the move subsystem (400 missing_request_id)', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);
    const first = await start(h, { folder: await folder('no-header-move') });
    await h.settle();

    const moved = await h.request('POST', `/v1/ferrets/${idOf(first)}/move`, { body: { agent: RUNTIME } });

    expect(moved.status).toBe(400);
    expect(JSON.parse(moved.body)).toMatchObject({ code: 'missing_request_id' });
    await h.stop();
  });
});

describe('#1586 model provenance across a lifecycle sequence, on the real path', () => {
  const modelArguments = (spec: RunSpec | undefined): readonly string[] => {
    const at = spec?.command.indexOf('--model') ?? -1;
    return at < 0 || spec === undefined ? [] : [spec.command[at + 1] as string];
  };

  test('a model the start asked for survives a stop/resume, and one it did not ask for stays unpinned', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    const picked = await start(h, { folder: await folder('picked'), model: 'kimi-k3' });
    const defaulted = await start(h, { folder: await folder('defaulted') });
    expect(picked.status).toBe(201);
    expect(defaulted.status).toBe(201);
    await h.settle();
    // The launch whose home (CLAUDE_CONFIG_DIR) is this ferret's.
    const launchOf = (id: string): RunSpec | undefined =>
      runner.specs.findLast(spec =>
        spec.command.some(part => part.startsWith('CLAUDE_CONFIG_DIR=') && part.endsWith(`/${id}`)),
      );
    const pickedId = idOf(picked);
    const defaultedId = idOf(defaulted);
    expect(modelArguments(launchOf(pickedId))).toEqual(['kimi-k3']);
    expect(modelArguments(launchOf(defaultedId))).toEqual([]);

    for (const id of [pickedId, defaultedId]) {
      expect(
        (await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} })).status,
      ).toBeLessThan(300);
      await h.settle();
      expect((await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} })).status).toBe(200);
      await h.settle();
    }

    expect(modelArguments(launchOf(pickedId))).toEqual(['kimi-k3']);
    expect(modelArguments(launchOf(defaultedId))).toEqual([]);
    await h.stop();
  });
});

/** The folders between FY_HOME and a ferret's home, as the testing host names them (home-relative; `''` is FY_HOME). */
const CHAIN: readonly (readonly [string, string])[] = [
  ['FY_HOME', ''],
  ['state', 'state'],
  ['the plugin’s state folder', 'state/claude-code'],
  ['agent-homes', 'state/claude-code/agent-homes'],
];

describe.each(LAUNCHING.map(row => [row.name, row] as const))(
  '#1587 the directory chain and the bound folder, on the one launch path: %s',
  (name, row) => {
    test.each(CHAIN)(
      'a %s writable by everyone (0777) refuses the launch with its reason, and the runner is not called',
      async (_label, component) => {
        const runner = new RecordingRunner();
        const h = await boot(runner);

        // A revive judges the chain at its resume; a start and an adoption at the start.
        const result = await row.drive(h, runner, `chain-${randomUUID()}`, async () => {
          h.setHomeFolder(component, { mode: 0o777 });
        });

        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.body).toContain('writable by its group or by everyone');
        expect(result.launches).toBe(0);
        await h.stop();
      },
    );

    test('a folder owned by another user, or replaced by a link, in the chain refuses too', async () => {
      for (const facts of [{ owner: 4242 }, { link: true as const }]) {
        const runner = new RecordingRunner();
        const h = await boot(runner);

        const result = await row.drive(h, runner, `chain-${randomUUID()}`, async () => {
          h.setHomeFolder('state/claude-code', facts);
        });

        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.launches).toBe(0);
        await h.stop();
      }
    });

    // The launch folder's identity is bound where it is first checked and re-verified as the last step before the harness.
    // Fault injection runs when \`launch.parts\` is asked: after \`start.decide\` has judged the folder, before the harness.
    const SWAPS: readonly (readonly [string, (h: TestHost, folder: string) => void])[] = [
      [
        'a link into the state home put where the project was',
        (h, folder) => h.setDirectory(folder, '/test-home/state'),
      ],
      ['a different directory put at the same path', (h, folder) => h.replaceDirectory(folder)],
      ['a link to another directory put where the project was', (h, folder) => h.setDirectory(folder, '/elsewhere')],
    ];
    test.each(SWAPS)('%s after the folder was checked starts nothing', async (_label, swap) => {
      let h: TestHost | undefined;
      let where = '';
      const underTest = name === 'revive' ? 2 : 1;
      atLaunch = launch => {
        if (launch === underTest && h !== undefined) swap(h, where);
      };
      const runner = new RecordingRunner();
      h = await boot(runner);

      const result = await row.drive(h, runner, `swap-${randomUUID()}`, async directory => {
        where = directory;
      });

      expect(launchesAsked).toBe(underTest);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body).toContain('no longer what was checked');
      expect(result.launches).toBe(0);
      await h.stop();
    });

    test('an unchanged folder launches (the verify is not a refusal in disguise)', async () => {
      const runner = new RecordingRunner();
      const h = await boot(runner);

      const result = await row.drive(h, runner, `same-${randomUUID()}`, async () => undefined);

      expect(result.status).toBeLessThan(300);
      expect(result.launches).toBe(1);
      await h.stop();
    });
  },
);
