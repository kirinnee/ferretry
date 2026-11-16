import { describe, expect, test } from 'bun:test';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import { homeText } from '../../../daemon/lib/harness/launch.ts';

/**
 * A project's own `.claude` settings win over a login's environment (v4 before 4.291.9; owner, !A500). Claude applies a
 * settings file's `env` over the process environment, and the `--settings` overlay over a project's files, so the ONLY way
 * a login's value could beat a repository's is by being written into the overlay. It never is: the login's values reach
 * the child's process environment alone. Fake values only.
 */

const base = {
  folder: '/work',
  permissionMode: 'auto' as const,
  instructions: [],
  settings: new Map(),
  hooks: new Map(),
};

const overlayOf = (parts: readonly LaunchPart[] = []) =>
  JSON.parse(homeText({ ...base, parts }).overlay) as { env?: Record<string, string> };

/**
 * Claude's settings precedence for `env`, lowest to highest: the process environment, the user's `settings.json` (the
 * agent home), the project's shared `.claude/settings.json`, the project's `.claude/settings.local.json`, then the
 * `--settings` flag. The highest layer naming a key wins.
 */
function effectiveEnv(
  processEnv: Readonly<Record<string, string>>,
  layers: {
    readonly project?: Record<string, string>;
    readonly local?: Record<string, string>;
    readonly flag?: Record<string, string>;
  },
): Record<string, string> {
  return { ...processEnv, ...layers.project, ...layers.local, ...layers.flag };
}

describe('a login’s environment is not pinned in the launch overlay', () => {
  test('env and shell parts (the child environment) never reach overlay env, and the rest of the overlay is unchanged', () => {
    const plain = JSON.parse(homeText({ ...base, parts: [] }).overlay) as Record<string, unknown>;
    const withEnv = JSON.parse(
      homeText({
        ...base,
        parts: [
          { kind: 'env', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gateway.example.test' } },
          { kind: 'shell', name: 'sh', env: { BAR: 'lit' } },
        ],
      }).overlay,
    ) as Record<string, unknown>;

    expect(withEnv).toEqual(plain);
    expect(withEnv).not.toHaveProperty('env');
    expect(withEnv.permissions).toBeDefined();
    expect(withEnv.hooks).toBeDefined();
  });

  test('even a login env or a pin part from an older caller is ignored: nothing is pinned', () => {
    const stale = {
      ...base,
      parts: [{ kind: 'pin', env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' } }],
      loginEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', FOO: '1' },
    } as never;

    const overlay = JSON.parse(homeText(stale).overlay) as Record<string, unknown>;

    expect(overlay).not.toHaveProperty('env');
  });

  test('a login’s plain FOO=1 loses to the project’s FOO=2 (settings.json and settings.local.json alike)', () => {
    const login = { FOO: '1' };
    const flag = overlayOf([{ kind: 'env', env: login }]).env;

    expect(effectiveEnv(login, { project: { FOO: '2' }, flag }).FOO).toBe('2');
    expect(effectiveEnv(login, { local: { FOO: '2' }, flag }).FOO).toBe('2');
  });

  test('a login’s literal BAR=lit loses to the project’s BAR, even one that blanks it', () => {
    const login = { BAR: 'lit' };
    const flag = overlayOf([{ kind: 'env', env: login }]).env;

    expect(effectiveEnv(login, { local: { BAR: '' }, flag }).BAR).toBe('');
  });

  test('a ${secret:…} key the project also sets leaves nothing in the overlay to refuse or to win', () => {
    const parts: readonly LaunchPart[] = [{ kind: 'env', env: { ANTHROPIC_AUTH_TOKEN: '${secret:GATEWAY_TOKEN}' } }];
    const text = homeText({ ...base, parts });

    expect(overlayOf(parts).env).toBeUndefined();
    expect(text.overlay).not.toContain('secret');
    expect(text.settings).not.toContain('secret');
    expect(
      effectiveEnv({ ANTHROPIC_AUTH_TOKEN: 'resolved' }, { local: { ANTHROPIC_AUTH_TOKEN: 'project' } })
        .ANTHROPIC_AUTH_TOKEN,
    ).toBe('project');
  });
});
