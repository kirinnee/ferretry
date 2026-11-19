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

const pane = (env: Record<string, string>, plugin = 'git-accounts', pathPrepend?: string[]): LaunchPart => ({
  kind: 'pane-env',
  plugin,
  env,
  ...(pathPrepend === undefined ? {} : { pathPrepend }),
});
const answering = (parts: readonly LaunchPart[]): LaunchPartSource => ({ parts: async () => parts });

function fixture(sources: readonly LaunchPartSource[], searchPath?: string) {
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
    daemonPath: () => searchPath,
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is literal text, never a template.
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
  test('pathPrepend goes first on the daemon’s PATH, in order, once each, and the part never names PATH itself', async () => {
    const f = fixture(
      [answering([pane({}, 'a', ['/fy/shims', '/fy/other']), pane({}, 'b', ['/fy/shims'])])],
      '/usr/bin:/bin',
    );

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(f.asked[0]?.PATH).toBe('/fy/shims:/fy/other:/usr/bin:/bin');
  });

  test('a shell part’s PATH (the devshell’s tools) is kept: the shim goes in front of IT, not of the daemon’s PATH', async () => {
    const shell: LaunchPart = { kind: 'shell', name: 'nix', env: { PATH: '/nix/store/devshell/bin:/usr/bin' } };
    // The gh part comes first in the list on purpose: the order of the parts never decides which PATH is the base.
    const f = fixture([answering([pane({}, 'git-accounts', ['/fy/shims']), shell])], '/daemon/bin');

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(f.asked[0]?.PATH).toBe('/fy/shims:/nix/store/devshell/bin:/usr/bin');
  });

  test('a shell part that left PATH empty is no PATH at all: the daemon’s is the base', async () => {
    const shell: LaunchPart = { kind: 'shell', name: 'nix', env: { PATH: '' } };
    const f = fixture([answering([shell, pane({}, 'git-accounts', ['/fy/shims'])])], '/daemon/bin');
    await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(f.asked[0]?.PATH).toBe('/fy/shims:/daemon/bin');
  });

  test('the daemon’s PATH is asked only when a part prepends (a daemon that cannot answer still starts ferrets)', () => {
    const unaskable = () => {
      throw new Error('not asked');
    };
    expect(paneEnvironment([pane({ A: '1' })], unaskable)).toEqual({ ok: true, value: { A: '1' } });
    expect(paneEnvironment([], unaskable)).toEqual({ ok: true, value: {} });
  });

  test('no pathPrepend leaves PATH alone (the kernel adds the daemon’s at spawn)', async () => {
    const f = fixture([answering([pane({ A: '1' })])], '/usr/bin');
    await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(f.asked[0]).not.toHaveProperty('PATH');
  });

  test('a daemon that knows no PATH gives the system folders, never a PATH of the prepend alone', () => {
    expect(paneEnvironment([pane({}, 'p', ['/fy/shims'])])).toEqual({
      ok: true,
      value: { PATH: '/fy/shims:/usr/local/bin:/usr/bin:/bin' },
    });
    expect(paneEnvironment([pane({}, 'p', ['/fy/shims'])], () => '')).toEqual({
      ok: true,
      value: { PATH: '/fy/shims:/usr/local/bin:/usr/bin:/bin' },
    });
  });

  test.each(['relative/bin', '', '/a:/b', '/a/../b', '/a\nb', '/x\u0000y'])(
    'a prepend folder %j is refused naming the plugin, and nothing starts',
    async folder => {
      const f = fixture([answering([pane({}, 'sneaky', [folder])])], '/usr/bin');
      const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.reason).toBe(
        "the sneaky plugin may only put an absolute folder first on a ferret's PATH, so the ferret was not started",
      );
      expect(f.runner.starts).toBe(0);
    },
  );
});
