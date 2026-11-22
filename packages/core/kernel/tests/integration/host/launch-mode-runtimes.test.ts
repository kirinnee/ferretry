import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Logins, Runners, type RunSpec } from '../../../../ferrets/contract/index.ts';
import { FakeLoginKind, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { type SecretName } from '../../../../vault/contract/index.ts';
import { FakeVault, fakeChildEnvironmentValues } from '../../../../vault/contract/testing/index.ts';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
  sampleLogin,
} from '../../../../../plugins/logins/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { diskFolders, type TestHost, testHost } from '../../../testing/index.ts';

/**
 * THE OWNER'S CASE THROUGH THE REAL DAEMON (PR 2346): a machine whose one runtime is an OLD document that still says
 * `agent: false`, plus logins with no runtime of their own. The REAL Ferrets, Runtimes and Claude Code halves, as the
 * generated registry builds them, derive the roster and start a ferret by the route the New ferret page POSTs to:
 *
 *  - the old runtime is listed (nothing about an old `agent` field hides it) beside one derived per READY login, and a login
 *    that needs sign-in yields none;
 *  - Create in `auto` mode reaches the runner exactly once, with the pane told `FY_SESSION_MODE=auto`;
 *  - an `interactive` launch is told `interactive` EVEN when the daemon's own environment says `auto`, so nothing inherited
 *    can turn an interactive launch autonomous (the runtime wrapper applies its fixed layer only for `auto`).
 *
 * Fixture values only; folders are real temporary directories.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

class RecordingRunner extends FakeRunner {
  readonly specs: RunSpec[] = [];
  /** What the pane was handed under `name`: the resolved value the fake vault kept behind the opaque handle. */
  paneValue(name: string): string | undefined {
    const spec = this.specs.at(-1);
    return spec === undefined ? undefined : fakeChildEnvironmentValues(spec.env)?.[name];
  }
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

const loginKindPlugin = () =>
  implementDaemon(
    definePlugin({
      id: 'logins',
      title: 'Logins (fake kind)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Logins, key: 'api-key' }] },
    }),
    { build: () => ({ hooks: { 'logins:api-key': new FakeLoginKind('api-key') } }) },
  );

const NEEDS_SIGN_IN = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'access_current',
  explanation: 'Sign in again.',
  lastCheckInconclusive: false,
} as const;

let fixture: string;
let inherited: string | undefined;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'launch-mode-runtimes-'));
  inherited = process.env.FY_SESSION_MODE;
});
afterEach(async () => {
  if (inherited === undefined) delete process.env.FY_SESSION_MODE;
  else process.env.FY_SESSION_MODE = inherited;
  await rm(fixture, { recursive: true, force: true });
});

async function boot(runner: RecordingRunner): Promise<TestHost> {
  const vault = new FakeVault();
  for (const name of ['LOGIN_CLAUDE_YOU', 'LOGIN_CLAUDE_TWO'])
    await vault.put(name as SecretName, 'fixture-not-a-credential');
  return await testHost({
    everyDirectory: true,
    harnessHomeFolders: await diskFolders(await mkdtemp(join(fixture, 'roots-'))),
    plugins: [real('ferrets'), real('runtimes'), real('claude-code'), loginKindPlugin(), runnerPlugin(runner)],
    // The owner's one runtime: an OLD file that still carries `agent: false` (read, the field dropped, nothing migrated).
    config: {
      runtimes: { 'claude-default': { login: 'claude-you', profile: 'plain', agent: false } },
      profiles: { plain: { contents: [] } },
    },
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gate: new FakeGate(),
      vault,
      asks: new FakeAsks(),
      logins: fakeLogins([
        sampleLogin('claude-you', { store: 'ferretry' }),
        sampleLogin('claude-two', { store: 'ferretry' }),
        sampleLogin('claude-down', { store: 'ferretry', status: NEEDS_SIGN_IN }),
      ]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
    },
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
}

const start = async (h: TestHost, mode: 'auto' | 'interactive') => {
  const folder = join(fixture, `work-${mode}`);
  await mkdir(join(folder, '.claude'), { recursive: true });
  return await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: {
      mode,
      runtime: 'claude-default',
      harness: 'claude-code',
      folder,
      ...(mode === 'auto' ? { prompt: 'say hello' } : {}),
    },
  });
};

test('the daemon derives the roster: the old agent:false runtime and one per ready login, none for a login that needs sign-in', async () => {
  const runner = new RecordingRunner();
  const h = await boot(runner);
  try {
    const roster = (await h.request('GET', '/v1/runtimes')).json<{ runtimes: { name: string }[] }>().runtimes;

    expect(roster.map(entry => entry.name).toSorted()).toEqual(['claude-default', 'claude-two']);
  } finally {
    await h.stop();
  }
});

test('Create in auto mode on the old agent:false runtime reaches the runner exactly once, told FY_SESSION_MODE=auto', async () => {
  const runner = new RecordingRunner();
  const h = await boot(runner);
  try {
    const answer = await start(h, 'auto');

    expect([answer.status, runner.starts, runner.specs.length]).toEqual([201, 1, 1]);
    expect(runner.paneValue('FY_SESSION_MODE')).toBe('auto');
  } finally {
    await h.stop();
  }
});

test('an interactive launch is told interactive even when the daemon environment says auto', async () => {
  process.env.FY_SESSION_MODE = 'auto';
  const runner = new RecordingRunner();
  const h = await boot(runner);
  try {
    const answer = await start(h, 'interactive');

    expect([answer.status, runner.starts]).toEqual([201, 1]);
    expect(runner.paneValue('FY_SESSION_MODE')).toBe('interactive');
  } finally {
    await h.stop();
  }
});
