import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { LaunchPart, LaunchPartSource } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { paneEnvironment } from '../../../../daemon/lib/ferrets/pane-env.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * What a plugin may give THIS pane (`pane-env` launch parts, r9 B4): plain variables, judged by name. A name the launch
 * or the login owns, or a `${secret…}` value, refuses the launch naming the plugin; the Ferretry identity wins over a part.
 */

const pane = (env: Record<string, string>, plugin = 'git-accounts'): LaunchPart => ({ kind: 'pane-env', plugin, env });
const answering = (parts: readonly LaunchPart[]): LaunchPartSource => ({ parts: async () => parts });

function fixture(sources: readonly LaunchPartSource[]) {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const harness = new FakeHarness('claude-code', '/fixture-fy/state/claude-code/agent-homes');
  const asked: Array<Readonly<Record<string, string>>> = [];
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
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => sources,
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: {
      childEnvironment: async (_ferret, env) => {
        asked.push(env);
        return ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  return { asked, runner, service: new FerretsService(registry, tokens, ports) };
}

describe('a pane-env launch part', () => {
  test('its variables reach the ferret’s environment, and the ferret’s own identity still wins', async () => {
    const f = fixture([
      answering([
        pane({ SSH_AUTH_SOCK: '/run/fy/gha_1.sock', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name' }),
        pane({ GIT_CONFIG_VALUE_0: 'Octo' }, 'other'),
      ]),
    ]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toMatchObject({
      SSH_AUTH_SOCK: '/run/fy/gha_1.sock',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Octo',
      FY_SESSION_ID: 'f1',
    });
  });

  test.each([
    'PATH',
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'FY_SESSION_ID',
    'FY_ANYTHING',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
  ])('a part that names %s refuses the launch, naming the plugin and the variable, and nothing starts', async name => {
    const f = fixture([answering([pane({ [name]: '/x' }, 'sneaky')])]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.reason).toBe(
      `the sneaky plugin may not set ${name} in a ferret's environment, so the ferret was not started`,
    );
    expect(f.runner.starts).toBe(0);
  });

  test('a value that names a secret, or a name that is not a variable, is refused, and the text carries no value', () => {
    const named = paneEnvironment([pane({ FOO: '${secret:TOKEN}' }, 'p')]);
    expect(named).toEqual({ ok: false, error: expect.stringContaining('the p plugin may not set FOO') });
    const odd = paneEnvironment([pane({ 'A=B': 'v' }, 'p')]);
    expect(odd).toEqual({ ok: false, error: expect.not.stringContaining('A=B') });
    expect(JSON.stringify(named)).not.toContain('TOKEN');
  });

  test('parts of other kinds are ignored, and no part is no change', () => {
    expect(paneEnvironment([{ kind: 'env', env: { PATH: '/x' } }])).toEqual({ ok: true, value: {} });
    expect(paneEnvironment([])).toEqual({ ok: true, value: {} });
  });
});
