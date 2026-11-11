import { describe, expect, test } from 'bun:test';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import { homeText, loginEnvPins, overlayDocument } from '../../../daemon/lib/harness/launch.ts';

/**
 * B190: a repository's `.claude/settings.local.json` can set (or blank) a provider variable, and Claude applies a
 * settings file's `env` over the process environment, so a login's `ANTHROPIC_BASE_URL` in the process env alone can be
 * undone by a cloned repo. The launch overlay (`--settings`) outranks the repo's files, so a login's LITERAL provider
 * values are pinned there. Fake values only.
 */

const base = {
  folder: '/work',
  permissionMode: 'auto' as const,
  instructions: [],
  settings: new Map(),
  hooks: new Map(),
};

const overlayOf = (loginEnv: Record<string, string>, parts: readonly LaunchPart[] = []) =>
  JSON.parse(homeText({ ...base, parts, loginEnv }).overlay) as { env?: Record<string, string> };

/**
 * Claude's settings precedence for `env`, lowest to highest: the user's `settings.json` (the agent home), the project's
 * shared `.claude/settings.json`, the project's `.claude/settings.local.json`, then the `--settings` flag. A settings
 * `env` entry replaces the process environment's value; the highest layer naming a key wins.
 */
function effectiveEnv(
  processEnv: Readonly<Record<string, string>>,
  layers: {
    readonly user?: Record<string, string>;
    readonly project?: Record<string, string>;
    readonly local?: Record<string, string>;
    readonly flag?: Record<string, string>;
  },
): Record<string, string> {
  return { ...processEnv, ...layers.user, ...layers.project, ...layers.local, ...layers.flag };
}

describe('a login’s literal provider values are pinned in the launch overlay', () => {
  test('ANTHROPIC_BASE_URL and a literal model are in overlay env; the rest of the overlay is unchanged', () => {
    const text = homeText({
      ...base,
      parts: [],
      loginEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_MODEL: 'fake-model' },
    });
    const overlay = JSON.parse(text.overlay) as Record<string, unknown>;

    expect(overlay.env).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_MODEL: 'fake-model' });
    expect(overlay.permissions).toBeDefined();
    expect(overlay.hooks).toBeDefined();
  });

  test('a repo’s settings.local.json that blanks ANTHROPIC_BASE_URL loses to the overlay', () => {
    const login = { ANTHROPIC_BASE_URL: 'https://gateway.example.test' };
    const overlay = overlayOf(login);

    const seen = effectiveEnv(login, { local: { ANTHROPIC_BASE_URL: '' }, flag: overlay.env });

    expect(seen.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
    // Control: with no pin, the same repo file wins and the login is undone.
    expect(effectiveEnv(login, { local: { ANTHROPIC_BASE_URL: '' } }).ANTHROPIC_BASE_URL).toBe('');
  });

  test('a login with no env adds no env key at all', () => {
    expect(overlayOf({}).env).toBeUndefined();
    expect(JSON.parse(homeText({ ...base, parts: [] }).overlay).env).toBeUndefined();
  });
});

describe('what is never pinned', () => {
  test('a secret reference, in either spelling, is in no file; a secret-backed token stays child env only', () => {
    const login = {
      ANTHROPIC_AUTH_TOKEN: '${secret:GW_TOKEN}',
      ANTHROPIC_API_KEY: '${secret?:OPTIONAL_KEY}',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
    };
    const text = homeText({ ...base, parts: [], loginEnv: login });

    expect(JSON.parse(text.overlay).env).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' });
    for (const file of Object.values(text)) expect(file).not.toContain('secret');
    // Residual, stated rather than hidden: a repo can still blank a secret-backed key, because it is not pinned.
    expect(
      effectiveEnv({ ANTHROPIC_AUTH_TOKEN: 'resolved-in-child' }, { local: { ANTHROPIC_AUTH_TOKEN: '' } })
        .ANTHROPIC_AUTH_TOKEN,
    ).toBe('');
  });

  test('an indirect $NAME or ${NAME} is not pinned as text; neither is a value that merely contains one', () => {
    const pins = loginEnvPins(
      {
        ANTHROPIC_AUTH_TOKEN: '$GATEWAY_TOKEN',
        OTHER_URL: '${GW_URL}',
        MIXED: 'prefix-$GW_PART',
        PLAIN_DOLLAR: 'costs 5$ today',
        LITERAL: 'kept',
      },
      [],
    );

    expect(pins).toEqual({ PLAIN_DOLLAR: 'costs 5$ today', LITERAL: 'kept' });
  });

  test('FY_*, HOME, CLAUDE_CONFIG_DIR and the secure-storage variable are never pinned', () => {
    const pins = loginEnvPins(
      {
        FY_SESSION_TOKEN: 'fake',
        FY_ANYTHING: 'fake',
        HOME: '/elsewhere',
        CLAUDE_CONFIG_DIR: '/elsewhere/.claude',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere/store',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      },
      [],
    );

    expect(pins).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' });
  });

  test('a key a launch part sets to a different value is never pinned (profile, MCP and shell env keep precedence)', () => {
    const parts: LaunchPart[] = [
      { kind: 'env', env: { ANTHROPIC_MODEL: 'profile-model', GITHUB_TOKEN: '${secret:GH_TOKEN}' } },
      { kind: 'shell', name: 'nix', env: { PATH: '/nix/bin' } },
    ];

    const pins = loginEnvPins(
      { ANTHROPIC_MODEL: 'login-model', GITHUB_TOKEN: 'login-token', PATH: 'login-path', ANTHROPIC_BASE_URL: 'u' },
      parts,
    );

    expect(pins).toEqual({ ANTHROPIC_BASE_URL: 'u' });
  });

  test('a part that sets the same literal value does not stop the pin', () => {
    const pins = loginEnvPins({ ANTHROPIC_BASE_URL: 'u' }, [{ kind: 'env', env: { ANTHROPIC_BASE_URL: 'u' } }]);

    expect(pins).toEqual({ ANTHROPIC_BASE_URL: 'u' });
  });
});

describe('the fixed layer wins', () => {
  test('a pin never overrides a key the fixed overlay itself sets', () => {
    const overlay = overlayDocument(
      { permissions: {}, env: { ANTHROPIC_BASE_URL: 'fixed' } },
      { ANTHROPIC_BASE_URL: 'pin', B: 'b' },
    );

    expect(overlay.env).toEqual({ ANTHROPIC_BASE_URL: 'fixed', B: 'b' });
  });
});

describe('the guard', () => {
  test('an overlay that would hold a secret reference is refused, whatever the spelling', () => {
    expect(() => overlayDocument({ env: { X: '${secret:NAME}' } }, {})).toThrow('secret');
    expect(() => overlayDocument({}, { X: '${secret?:NAME}' })).toThrow('secret');
    expect(() => overlayDocument({ hooks: { command: 'echo ${secret:NAME}' } }, {})).toThrow('secret');
  });
});

describe('a pin never beats the merged settings document’s own env (B1)', () => {
  const withDocument = (env: Record<string, string>, loginEnv: Record<string, string>) =>
    homeText({
      ...base,
      parts: [],
      settings: new Map([['harness', { settings: { env } }]]),
      loginEnv,
    });

  test('a key a real settings item sets is not pinned; the home settings.json keeps the document’s value', () => {
    const text = withDocument(
      { ANTHROPIC_MODEL: 'settings-model', ANTHROPIC_BASE_URL: 'https://settings.example.test' },
      { ANTHROPIC_MODEL: 'login-model', ANTHROPIC_BASE_URL: 'https://login.example.test', LOGIN_ONLY: 'kept' },
    );

    // Only the key the document does not set is pinned: --settings would otherwise beat settings.json.
    expect(JSON.parse(text.overlay).env).toEqual({ LOGIN_ONLY: 'kept' });
    const document = JSON.parse(text.settings) as { env: Record<string, string> };
    expect(document.env.ANTHROPIC_MODEL).toBe('settings-model');
    expect(document.env.ANTHROPIC_BASE_URL).toBe('https://settings.example.test');
    // End to end through Claude's precedence: the settings value is the one the child sees.
    const seen = effectiveEnv(
      { ANTHROPIC_MODEL: 'login-model' },
      { user: document.env, flag: JSON.parse(text.overlay).env },
    );
    expect(seen.ANTHROPIC_MODEL).toBe('settings-model');
  });

  test('control: with no settings item the same login value is pinned', () => {
    const text = homeText({ ...base, parts: [], loginEnv: { ANTHROPIC_MODEL: 'login-model' } });

    expect(JSON.parse(text.overlay).env).toEqual({ ANTHROPIC_MODEL: 'login-model' });
  });

  test('a settings item with no env block pins as before', () => {
    const text = homeText({
      ...base,
      parts: [],
      settings: new Map([['harness', { settings: { model: 'opus' } }]]),
      loginEnv: { ANTHROPIC_MODEL: 'login-model' },
    });

    expect(JSON.parse(text.overlay).env).toEqual({ ANTHROPIC_MODEL: 'login-model' });
  });
});
