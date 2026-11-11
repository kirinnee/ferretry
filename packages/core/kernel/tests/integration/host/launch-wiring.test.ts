import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Runners, type RunSpec } from '../../../../ferrets/contract/index.ts';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { fakeLoginChanges, fakeLogins } from '../../../../../plugins/logins/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

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
 * A MOVE is the fifth path. Its route (`POST /v1/ferrets/:id/move`) is still a 503 skeleton on this base (its account
 * inventory, planner and session directory are unbound), so it refuses before anything is launched: that is pinned here
 * so the day it is bound it must go through `launchAttempt` too.
 *
 * Fixture values only; folders are real temporary directories because the folder settings are read from disk.
 */

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
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function boot(runner: RecordingRunner): Promise<TestHost> {
  const h = await testHost({
    plugins: [real('ferrets'), real('runtimes'), real('claude-code'), runnerPlugin(runner)],
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
  h.putRoot('fleet', `homes/${ID}/.fy/fixed.json`, FIXED);
  return h;
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { mode: 'interactive', runtime: RUNTIME, harness: 'claude-code', ...body },
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
    // refuse before launching anything, and the day it is bound its relaunch is `launchAttempt` like the rest.
    name: 'move',
    drive: async (h, runner, name, plant) => {
      const where = await folder(name);
      const first = await start(h, { folder: where });
      expect(first.status).toBe(201);
      await h.settle();
      await plant(where);
      const before = runner.starts;
      const moved = await h.request('POST', `/v1/ferrets/${idOf(first)}/move`, { body: { agent: RUNTIME } });
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

      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.launches).toBe(0);
      if (!isMove) for (const sentence of refused.says) expect(result.body).toContain(sentence);
      await h.stop();
    },
  );

  test('(iii)(iv)(v) a clean folder launches; the credential is in no argv and the login’s pins are in the private settings file', async () => {
    const runner = new RecordingRunner();
    const h = await boot(runner);

    const result = await row.drive(h, runner, `clean-${randomUUID()}`, async () => undefined);

    if (isMove) {
      expect(result.status).toBeGreaterThanOrEqual(400);
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
