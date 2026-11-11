import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { LaunchPart } from '../../../../contract/index.ts';
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
  readonly parts?: readonly LaunchPart[];
  readonly unknownSecrets?: readonly string[];
}) {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const harness = new FakeHarness('claude-code');
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
    harness: key => (key === 'claude-code' ? harness : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [{ parts: async () => options.parts ?? [] }],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    ...(options.loginEnv === undefined ? {} : { loginEnv: options.loginEnv }),
    vault: {
      childEnvironment: async (_ferret, env) => {
        asked.push({ ...env });
        const unknown = options.unknownSecrets ?? [];
        return unknown.length > 0 ? err({ unknown: [...unknown] }) : ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  return { asked, harness, service: new FerretsService(registry, tokens, ports) };
}

const env =
  (values: Env): NonNullable<FerretsPorts['loginEnv']> =>
  async () =>
    ok(values);

describe('a ferret launch carries its login’s environment', () => {
  test('a literal and a ${secret:X} login value both reach the Vault by name, as written', async () => {
    const f = fixture({
      loginEnv: env({
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_AUTH_TOKEN: '${secret:GW_TOKEN}',
      }),
    });

    const started = await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

    expect(started.ok).toBe(true);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
    // The reference stays a reference until the Vault resolves it into the child.
    expect(f.asked[0]?.ANTHROPIC_AUTH_TOKEN).toBe('${secret:GW_TOKEN}');
  });

  test('the spec carries the login env as its own field, and none of it is a launch part', async () => {
    const f = fixture({ loginEnv: env({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }) });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

    expect(f.harness.launched[0]?.loginEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' });
    expect(f.harness.launched[0]?.parts).toEqual([]);
  });

  test('FY_*, an MCP env part and a shell part keep precedence over the login', async () => {
    const f = fixture({
      loginEnv: env({ FOO: 'login', PATH: 'login-path', GITHUB_TOKEN: 'login-token' }),
      parts: [
        { kind: 'env', env: { GITHUB_TOKEN: '${secret:GH_TOKEN}' } },
        { kind: 'shell', name: 'nix', env: { PATH: '/nix/shell/bin' } },
      ],
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

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

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

    const names = Object.keys(f.asked[0] ?? {});
    expect(names).not.toContain('HOME');
    expect(names).not.toContain('CLAUDE_CONFIG_DIR');
    expect(names).not.toContain('CODEX_HOME');
    expect(names).not.toContain('FY_ANYTHING');
    expect(f.asked[0]?.FY_SESSION_TOKEN).not.toBe('forged');
    expect(f.asked[0]?.FY_SESSION_ID).not.toBe('forged');
    expect(f.asked[0]?.KEEP).toBe('kept');
    expect(f.harness.launched[0]?.loginEnv).toEqual({ KEEP: 'kept' });
  });

  test('a ferret with no login, or a login with no env, gets nothing extra; the port is not asked without a login', async () => {
    let asks = 0;
    const f = fixture({
      loginEnv: async () => {
        asks += 1;
        return ok({});
      },
    });

    await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' });
    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'oauth', by: 'owner' });

    expect(asks).toBe(1);
    expect(f.harness.launched[0]?.loginEnv).toBeUndefined();
    expect(f.harness.launched[1]?.loginEnv).toBeUndefined();
    for (const asked of f.asked) expect(Object.keys(asked).every(name => name.startsWith('FY_'))).toBe(true);
  });

  test('an unknown login fails closed with a sentence, before a token is issued or anything is launched', async () => {
    const f = fixture({ loginEnv: async login => err(`there is no login named ${login}`) });

    const started = await f.service.start({ folder: '/work', harness: 'claude-code', login: 'ghost', by: 'owner' });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe('there is no login named ghost');
    expect(f.harness.launched).toHaveLength(0);
    expect(f.asked).toHaveLength(0);
  });

  test('a ${secret:X} the Vault does not know is the existing login_unavailable refusal', async () => {
    const f = fixture({ loginEnv: env({ ANTHROPIC_AUTH_TOKEN: '${secret:MISSING}' }), unknownSecrets: ['MISSING'] });

    const started = await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

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

    await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' });

    expect(seen).toEqual(['claude-code']);
  });
});
