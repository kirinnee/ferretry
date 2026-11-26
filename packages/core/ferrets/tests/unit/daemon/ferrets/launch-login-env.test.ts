import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { type LaunchPart, PERSON_ORIGIN } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A ferret launch carries the environment of its login. The service asks the login-env port for it, merges it into the
 * child environment BEFORE the launch parts (so MCP, shell parts and `FY_*` keep precedence) and hands the Vault the
 * result, which resolves `${secret:}` references. Fake values only; nothing here reads a real home or a real login.
 */

type Env = Readonly<Record<string, string>>;

function fixture(options: {
  readonly loginEnv?: FerretsPorts['loginEnv'];
  readonly loginLaunchEnv?: FerretsPorts['loginLaunchEnv'];
  readonly parts?: readonly LaunchPart[];
  readonly unknownSecrets?: readonly string[];
  readonly harness?: string;
  readonly subscriptionRefused?: boolean;
}) {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const harness = new FakeHarness(options.harness ?? 'claude-code');
  const runner = new FakeRunner();
  const asked: Env[] = [];
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === harness.key ? harness : undefined),
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [{ parts: async () => options.parts ?? [] }],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    ...(options.loginEnv === undefined ? {} : { loginEnv: options.loginEnv }),
    ...(options.loginLaunchEnv === undefined ? {} : { loginLaunchEnv: options.loginLaunchEnv }),
    vault: {
      childEnvironment: async (_ferret, env, destination) => {
        expect(destination).toBe(harness.key);
        asked.push({ ...env });
        if (options.subscriptionRefused) return err({ unknown: [], code: 'subscription_login' });
        const unknown = options.unknownSecrets ?? [];
        return unknown.length > 0 ? err({ unknown: [...unknown] }) : ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  return { asked, harness, runner, service: new FerretsService(registry, tokens, ports) };
}

const env =
  (values: Env): NonNullable<FerretsPorts['loginEnv']> =>
  async () =>
    ok(values);

describe('a ferret launch carries its login’s environment', () => {
  test('a permitted OpenCode replacement spends the already checked sealed environment once after releasing the old pane', async () => {
    const options = { harness: 'opencode', subscriptionRefused: false };
    const f = fixture(options);
    const started = await f.service.start({ folder: '/work', harness: 'opencode', by: 'owner' }, PERSON_ORIGIN);
    if (!started.ok) throw new Error('fixture must start');
    const before = await f.service.handle(started.value);
    expect(before).toBeDefined();
    const prepareHome = f.harness.prepareHome.bind(f.harness);
    f.harness.prepareHome = async spec => {
      // A second Vault check would now refuse: the launch must spend exactly the handle it preflighted.
      options.subscriptionRefused = true;
      expect(await f.runner.alive(before!)).toBe(false);
      return await prepareHome(spec);
    };
    const replaced = await f.service.resume(started.value, undefined, {
      origin: PERSON_ORIGIN,
      replaceLiveTerminal: true,
    });
    expect(replaced).toMatchObject({ ok: true });
    expect(f.asked).toHaveLength(2);
    expect(f.harness.launched).toHaveLength(2);
    const after = await f.service.handle(started.value);
    expect(after).not.toBe(before);
    expect(await f.runner.alive(after!)).toBe(true);
  });
  test('the sealed subscription policy returns a typed start refusal without launching a harness', async () => {
    const f = fixture({ harness: 'opencode', subscriptionRefused: true });
    const started = await f.service.start({ folder: '/work', harness: 'opencode', by: 'owner' }, PERSON_ORIGIN);
    expect(started).toMatchObject({ ok: false, error: { code: 'refused' } });
    if (started.ok) throw new Error('subscription must refuse');
    expect(started.error.reason).toContain('subscription credentials');
    expect(f.asked).toHaveLength(1);
  });
  test('a literal and a ${secret:X} login value both reach the Vault by name, as written', async () => {
    const f = fixture({
      loginEnv: env({
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_AUTH_TOKEN: '${secret:GW_TOKEN}',
      }),
    });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
    // The reference stays a reference until the Vault resolves it into the child.
    expect(f.asked[0]?.ANTHROPIC_AUTH_TOKEN).toBe('${secret:GW_TOKEN}');
  });

  test('the login env reaches the child only: the spec carries no copy of it, and none of it is a launch part', async () => {
    const f = fixture({ loginEnv: env({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }) });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    expect(f.asked[0]?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
    // Nothing hands a harness the login's values to pin: a project's own `.claude` env wins over them (docs/secrets.md).
    expect(f.harness.launched[0]).not.toHaveProperty('loginEnv');
    expect(f.harness.launched[0]?.parts).toEqual([]);
  });

  test('a pane-env part (the Git account’s no-identity ssh) outranks a login that sets GIT_SSH_COMMAND / GIT_SSH', async () => {
    const f = fixture({
      loginEnv: env({
        GIT_SSH_COMMAND: 'ssh -i /login/key',
        GIT_SSH: '/login/ssh',
        GIT_CONFIG_COUNT: '9',
        FOO: 'login',
      }),
      parts: [
        {
          kind: 'pane-env',
          plugin: 'git-accounts',
          env: { GIT_SSH_COMMAND: 'ssh -F none -o IdentityAgent=none', GIT_CONFIG_COUNT: '0' },
        },
      ],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    expect(f.asked[0]?.GIT_SSH_COMMAND).toBe('ssh -F none -o IdentityAgent=none');
    expect(f.asked[0]?.GIT_CONFIG_COUNT).toBe('0');
    // What the part does not name is still the login's.
    expect(f.asked[0]?.GIT_SSH).toBe('/login/ssh');
    expect(f.asked[0]?.FOO).toBe('login');
  });

  test('a pane-env GIT_CONFIG_PARAMETERS is APPENDED to the login’s, so git (which applies it last, in order) reads the part’s entry over the login’s and keeps the login’s others', async () => {
    const f = fixture({
      loginEnv: env({
        GIT_CONFIG_PARAMETERS: `'commit.gpgsign'='true' 'tag.gpgsign'='true' 'http.proxy'='http://login.example.test'`,
      }),
      parts: [
        {
          kind: 'pane-env',
          plugin: 'git-accounts',
          env: { GIT_CONFIG_PARAMETERS: `'commit.gpgsign'='false' 'tag.gpgsign'='false'` },
        },
      ],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    // Real git reads the FINAL environment the launch handed the Vault.
    const final = f.asked[0] ?? {};
    const git = (name: string): string => {
      const run = Bun.spawnSync(['git', 'config', '--get', name], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/nonexistent-fy-home',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_PARAMETERS: final.GIT_CONFIG_PARAMETERS ?? '',
        },
      });
      return new TextDecoder().decode(run.stdout).trim();
    };
    expect(git('commit.gpgsign')).toBe('false');
    expect(git('tag.gpgsign')).toBe('false');
    expect(git('http.proxy')).toBe('http://login.example.test');
  });

  test('a pane-env GIT_CONFIG_PARAMETERS with no login value is just the part’s', async () => {
    const f = fixture({
      parts: [{ kind: 'pane-env', plugin: 'git-accounts', env: { GIT_CONFIG_PARAMETERS: `'commit.gpgsign'='false'` } }],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' }, PERSON_ORIGIN);

    expect(f.asked[0]?.GIT_CONFIG_PARAMETERS).toBe(`'commit.gpgsign'='false'`);
  });

  test('FY_*, an MCP env part and a shell part keep precedence over the login', async () => {
    const f = fixture({
      loginEnv: env({ FOO: 'login', PATH: 'login-path', GITHUB_TOKEN: 'login-token' }),
      parts: [
        { kind: 'env', env: { GITHUB_TOKEN: '${secret:GH_TOKEN}' } },
        { kind: 'shell', name: 'nix', env: { PATH: '/nix/shell/bin' } },
      ],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    expect(f.asked[0]?.FOO).toBe('login');
    expect(f.asked[0]?.GITHUB_TOKEN).toBe('${secret:GH_TOKEN}');
    expect(f.asked[0]?.PATH).toBe('/nix/shell/bin');
  });

  test('HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and FY_* are never taken from a login', async () => {
    const f = fixture({
      loginEnv: env({
        HOME: '/elsewhere',
        CLAUDE_CONFIG_DIR: '/elsewhere/.claude',
        CODEX_HOME: '/elsewhere/.codex',
        FY_SESSION_ID: 'forged',
        FY_SESSION_TOKEN: 'forged',
        FY_ANYTHING: 'forged',
        KEEP: 'kept',
      }),
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    const names = Object.keys(f.asked[0] ?? {});
    expect(names).not.toContain('HOME');
    expect(names).not.toContain('CLAUDE_CONFIG_DIR');
    expect(names).not.toContain('CODEX_HOME');
    expect(names).not.toContain('FY_ANYTHING');
    expect(f.asked[0]?.FY_SESSION_TOKEN).not.toBe('forged');
    expect(f.asked[0]?.FY_SESSION_ID).not.toBe('forged');
    expect(f.asked[0]?.KEEP).toBe('kept');
    expect(f.harness.launched[0]).not.toHaveProperty('loginEnv');
  });

  test('a ferret with no login, or a login with no env, gets nothing extra; the port is not asked without a login', async () => {
    let asks = 0;
    const f = fixture({
      loginEnv: async () => {
        asks += 1;
        return ok({});
      },
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' }, PERSON_ORIGIN);
    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'oauth', by: 'owner' }, PERSON_ORIGIN);

    expect(asks).toBe(1);
    expect(f.harness.launched[0]).not.toHaveProperty('loginEnv');
    expect(f.harness.launched[1]).not.toHaveProperty('loginEnv');
    for (const asked of f.asked) expect(Object.keys(asked).every(name => name.startsWith('FY_'))).toBe(true);
  });

  test('an unknown login fails closed with a sentence, before a token is issued or anything is launched', async () => {
    const f = fixture({ loginEnv: async login => err(`there is no login named ${login}`) });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'ghost', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe('there is no login named ghost');
    expect(f.harness.launched).toHaveLength(0);
    expect(f.asked).toHaveLength(0);
  });

  test('a ${secret:X} the Vault does not know is the existing login_unavailable refusal', async () => {
    const f = fixture({ loginEnv: env({ ANTHROPIC_AUTH_TOKEN: '${secret:MISSING}' }), unknownSecrets: ['MISSING'] });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe('unknown secrets: MISSING');
  });

  test('the port is asked with the ferret’s own harness, so a codex ferret gets the codex half', async () => {
    const seen: string[] = [];
    const f = fixture({
      loginEnv: async (_login, harness) => {
        seen.push(harness);
        return ok({});
      },
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN);

    expect(seen).toEqual(['claude-code']);
  });
});

const STORE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

describe('a ferret launch carries the environment Ferretry sets for its login’s sign-in', () => {
  test('the store variable reaches the Vault by name and value, with the real HOME untouched', async () => {
    const f = fixture({ loginLaunchEnv: env({ [STORE]: '/fy/state/logins/credentials/work' }) });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'work', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    expect(f.asked[0]?.[STORE]).toBe('/fy/state/logins/credentials/work');
    expect(Object.keys(f.asked[0] ?? {})).not.toContain('HOME');
  });

  test('it is merged AFTER the launch parts, so no part (MCP, shell, env) and no login-file env overrides it', async () => {
    const f = fixture({
      loginEnv: env({ [STORE]: '/from/login/file' }),
      loginLaunchEnv: env({ [STORE]: '/the/store' }),
      parts: [
        { kind: 'env', env: { [STORE]: '/from/mcp' } },
        { kind: 'shell', name: 'nix', env: { [STORE]: '/from/shell' } },
      ],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'work', by: 'owner' }, PERSON_ORIGIN);

    expect(f.asked[0]?.[STORE]).toBe('/the/store');
  });

  test('it never sets HOME, the harness homes or FY_*', async () => {
    const f = fixture({
      loginLaunchEnv: env({
        HOME: '/elsewhere',
        CLAUDE_CONFIG_DIR: '/elsewhere/.claude',
        CODEX_HOME: '/elsewhere/.codex',
        FY_SESSION_TOKEN: 'forged',
        [STORE]: '/the/store',
      }),
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'work', by: 'owner' }, PERSON_ORIGIN);

    const names = Object.keys(f.asked[0] ?? {});
    for (const reserved of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) expect(names).not.toContain(reserved);
    expect(f.asked[0]?.FY_SESSION_TOKEN).not.toBe('forged');
    expect(f.asked[0]?.[STORE]).toBe('/the/store');
  });

  test('a login that cannot sign a pane in refuses the start as login_unavailable, before a token or a launch', async () => {
    const f = fixture({
      loginLaunchEnv: async login => err(`the login ${login} is signed out, so the ferret was not started`),
    });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'work', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe('the login work is signed out, so the ferret was not started');
    expect(f.harness.launched).toHaveLength(0);
    expect(f.asked).toHaveLength(0);
  });

  test('a ferret with no login never asks for it', async () => {
    let asks = 0;
    const f = fixture({
      loginLaunchEnv: async () => {
        asks += 1;
        return ok({});
      },
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' }, PERSON_ORIGIN);

    expect(asks).toBe(0);
  });
});
