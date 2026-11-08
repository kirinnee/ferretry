import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { CommandLocation, PathsPort } from '../../../contract/ports.ts';
import { nodeExecutableProbe } from '../../../host/adapters/executable.ts';
import { bootHost } from '../../../host/host.ts';
import { gatedOverrides, gatedWhich } from '../../../host/paths.ts';
import { locateCommand, mayReadOverride } from '../../../host/which.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, type Permissions } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * K13 `kernel.paths.locate` (item #13): today's `FY_CLOUDFLARED` rule — the operator's override variable, else the
 * bounded `which` — for a plugin that declares `permissions.which` AND the variable in `permissions.whichOverrides`.
 * An override that is not an absolute, plain, executable path whose basename is the command is `override_unusable`,
 * and the PATH is then NOT searched. Nothing is executed and no other variable is read.
 */
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const folder = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-locate-`));
  parents.push(parent);
  return parent;
};

/** A probe that records every path it is asked about and accepts only `accepted`. */
const recording = (accepted: readonly string[] = []) => {
  const asked: string[] = [];
  return {
    asked,
    probe: async (path: string) => {
      asked.push(path);
      return accepted.includes(path);
    },
  };
};

/** The operator's environment, recording every name asked. */
const environment = (values: Readonly<Record<string, string>>) => {
  const read: string[] = [];
  return {
    read,
    variable: (name: string) => {
      read.push(name);
      return values[name];
    },
  };
};

const OVERRIDE = { override: 'FY_CLOUDFLARED' } as const;

describe('K13 locateCommand: the override, else which', () => {
  test('an unset override searches as which does, and reads only the one variable', async () => {
    const env = environment({ PATH: '/elsewhere', FY_OTHER: '/x/cloudflared' });
    const { asked, probe } = recording(['/usr/bin/cloudflared']);
    expect(await locateCommand('cloudflared', OVERRIDE, { variable: env.variable, path: '/usr/bin', probe })).toEqual({
      kind: 'found',
      path: '/usr/bin/cloudflared',
      via: 'path',
    });
    expect(env.read).toEqual(['FY_CLOUDFLARED']);
    expect(asked).toEqual(['/usr/bin/cloudflared']);
  });

  test('a blank override is unset; nothing found is absent', async () => {
    const { probe } = recording();
    const env = environment({ FY_CLOUDFLARED: '   ' });
    expect(await locateCommand('cloudflared', OVERRIDE, { variable: env.variable, path: '/usr/bin', probe })).toEqual({
      kind: 'absent',
    });
  });

  test('the caller’s directories are searched before PATH, as which', async () => {
    const { probe } = recording(['/opt/cf/cloudflared', '/usr/bin/cloudflared']);
    expect(
      await locateCommand(
        'cloudflared',
        { ...OVERRIDE, directories: ['/opt/cf'] },
        { variable: () => undefined, path: '/usr/bin', probe },
      ),
    ).toEqual({ kind: 'found', path: '/opt/cf/cloudflared', via: 'path' });
  });

  test('a usable override wins (trimmed), and PATH is never searched', async () => {
    const { asked, probe } = recording(['/opt/cf/cloudflared', '/usr/bin/cloudflared']);
    expect(
      await locateCommand('cloudflared', OVERRIDE, {
        variable: () => '  /opt/cf/cloudflared ',
        path: '/usr/bin',
        probe,
      }),
    ).toEqual({ kind: 'found', path: '/opt/cf/cloudflared', via: 'override' });
    expect(asked).toEqual(['/opt/cf/cloudflared']);
  });

  test('a relative override is unusable and is never probed or resolved', async () => {
    const { asked, probe } = recording(['bin/cloudflared', '/usr/bin/cloudflared']);
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => 'bin/cloudflared', path: '/usr/bin', probe }),
    ).toEqual({ kind: 'override_unusable', variable: 'FY_CLOUDFLARED', path: 'bin/cloudflared' });
    expect(asked).toEqual([]);
  });

  test('a wrong basename is unusable even when it is executable (FY_CLOUDFLARED=/bin/sh)', async () => {
    const { asked, probe } = recording(['/bin/sh', '/usr/bin/cloudflared']);
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => '/bin/sh', path: '/usr/bin', probe }),
    ).toEqual({ kind: 'override_unusable', variable: 'FY_CLOUDFLARED', path: '/bin/sh' });
    expect(asked).toEqual([]);
    expect(
      await locateCommand('cloudflared', OVERRIDE, {
        variable: () => '/opt/cloudflared-2/cloudflared.sh',
        path: '/usr/bin',
        probe,
      }),
    ).toMatchObject({ kind: 'override_unusable' });
  });

  test('a set but missing override does NOT fall back to PATH', async () => {
    const { asked, probe } = recording(['/usr/bin/cloudflared']);
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => '/gone/cloudflared', path: '/usr/bin', probe }),
    ).toEqual({ kind: 'override_unusable', variable: 'FY_CLOUDFLARED', path: '/gone/cloudflared' });
    expect(asked).toEqual(['/gone/cloudflared']);
  });

  test('a probe that throws is unusable, never a fallback', async () => {
    const probe = async (): Promise<boolean> => {
      throw new Error('EACCES');
    };
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => '/opt/cloudflared', path: '/usr/bin', probe }),
    ).toMatchObject({ kind: 'override_unusable' });
  });

  test('an override that is not one plain absolute path is unusable', async () => {
    for (const named of [
      '/opt/../bin/cloudflared',
      '/opt/./cloudflared',
      '/opt//cloudflared',
      '/opt/cloudflared/',
      '/opt/cloud\0flared/cloudflared',
    ]) {
      const { asked, probe } = recording([named, '/usr/bin/cloudflared']);
      expect(await locateCommand('cloudflared', OVERRIDE, { variable: () => named, path: '/usr/bin', probe })).toEqual({
        kind: 'override_unusable',
        variable: 'FY_CLOUDFLARED',
        path: named,
      });
      expect(asked).toEqual([]);
    }
  });

  test('a name that is not one plain command is absent and reads no variable', async () => {
    const env = environment({ FY_CLOUDFLARED: '/opt/cloudflared' });
    const { asked, probe } = recording(['/opt/cloudflared']);
    for (const name of ['../cloudflared', '/opt/cloudflared', '', '.', '..'])
      expect(await locateCommand(name, OVERRIDE, { variable: env.variable, path: '/opt', probe })).toEqual({
        kind: 'absent',
      });
    expect(env.read).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('nothing is executed: a real override that would leave a mark when run leaves none', async () => {
    const parent = await folder();
    await mkdir(`${parent}/bin`);
    await mkdir(`${parent}/marks`);
    const script = `${parent}/bin/cloudflared`;
    await writeFile(script, `#!/bin/sh\ntouch ${parent}/marks/ran\n`);
    await chmod(script, 0o755);
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => script, path: '', probe: nodeExecutableProbe }),
    ).toEqual({ kind: 'found', path: script, via: 'override' });
    expect(
      await locateCommand('cloudflared', OVERRIDE, {
        variable: () => undefined,
        path: `${parent}/bin`,
        probe: nodeExecutableProbe,
      }),
    ).toEqual({ kind: 'found', path: script, via: 'path' });
    // A file without the execute bit is not executable: unusable, no fallback.
    await chmod(script, 0o644);
    expect(
      await locateCommand('cloudflared', OVERRIDE, { variable: () => script, path: '', probe: nodeExecutableProbe }),
    ).toMatchObject({ kind: 'override_unusable' });
    expect(await readdir(`${parent}/marks`)).toEqual([]);
  });
});

describe('K13 the override variable gate (permissions.whichOverrides)', () => {
  test('only an exact declared name of the FY_ grammar is readable; * and patterns match nothing', () => {
    expect(mayReadOverride(['FY_CLOUDFLARED'], 'FY_CLOUDFLARED')).toBe(true);
    expect(mayReadOverride(['FY_CLOUDFLARED'], 'FY_CLOUDFLARE')).toBe(false);
    expect(mayReadOverride(['*'], 'FY_CLOUDFLARED')).toBe(false);
    expect(mayReadOverride(['*'], '*')).toBe(false);
    expect(mayReadOverride(['FY_*'], 'FY_*')).toBe(false);
    expect(mayReadOverride(['PATH', 'HOME', 'AWS_SECRET'], 'PATH')).toBe(false);
    expect(mayReadOverride(['fy_cloudflared'], 'fy_cloudflared')).toBe(false);
    expect(mayReadOverride([`FY_${'A'.repeat(61)}`], `FY_${'A'.repeat(61)}`)).toBe(false);
    expect(mayReadOverride([`FY_${'A'.repeat(60)}`], `FY_${'A'.repeat(60)}`)).toBe(true);
    expect(mayReadOverride(undefined, 'FY_CLOUDFLARED')).toBe(false);
    expect(mayReadOverride(['FY_CLOUDFLARED'], undefined)).toBe(false);
  });

  const base = (): PathsPort & { readonly calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      home: () => '/h',
      checkDirectory: async () => ({ ok: true as const, value: { realPath: '/x' } }),
      which: async () => undefined,
      locate: async (name, options) => {
        calls.push(`${name}:${options.override}`);
        return { kind: 'absent' as const };
      },
      whichFor: async () => ({ kind: 'unprovable' as const }),
    };
  };

  test('an undeclared variable is refused naming the plugin, before anything is read', async () => {
    const inner = base();
    const paths = gatedOverrides('connections', ['FY_CLOUDFLARED'], inner);
    await expect(paths.locate('cloudflared', { override: 'FY_OTHER' })).rejects.toThrow(
      'connections asked for an override variable its permissions.whichOverrides does not declare',
    );
    await expect(paths.locate('sh', { override: 'PATH' })).rejects.toThrow('permissions.whichOverrides');
    await expect(gatedOverrides('stranger', undefined, inner).locate('x', OVERRIDE)).rejects.toThrow(
      'stranger asked for an override variable',
    );
    expect(inner.calls).toEqual([]);
    expect(await paths.locate('cloudflared', OVERRIDE)).toEqual({ kind: 'absent' });
    expect(inner.calls).toEqual(['cloudflared:FY_CLOUDFLARED']);
  });

  test('without permissions.which every locate is refused, whatever overrides are declared', async () => {
    const paths = gatedWhich('connections', false, gatedOverrides('connections', ['FY_CLOUDFLARED'], base()));
    await expect(paths.locate('cloudflared', OVERRIDE)).rejects.toThrow(
      'connections did not declare permissions.which',
    );
  });
});

/** A plugin that reports `locate` answers through its own kernel. */
const locator = (
  id: string,
  seen: Record<string, (override: string) => Promise<CommandLocation>>,
  permissions?: Permissions,
) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      ...(permissions === undefined ? {} : { permissions }),
    }),
    {
      build: ({ kernel }) => {
        seen[id] = async override => await kernel.paths.locate('cloudflared', { override });
        return {};
      },
    },
  );

type Answer = CommandLocation | { readonly refused: string };
const answer = async (call: (() => Promise<CommandLocation>) | undefined): Promise<Answer> => {
  if (call === undefined) throw new Error('plugin was not built');
  try {
    return await call();
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

/** The cases both hosts must answer alike: [plugin, variable]. */
const CASES: readonly (readonly [string, string])[] = [
  ['declared', 'FY_CLOUDFLARED'],
  ['declared', 'FY_UNSET'],
  ['declared', 'FY_RELATIVE'],
  ['declared', 'FY_WRONG_NAME'],
  ['declared', 'FY_MISSING'],
  ['declared', 'FY_UNDECLARED'],
  ['declared', 'HOME'],
  ['wildcard', 'FY_CLOUDFLARED'],
  ['overrides-only', 'FY_CLOUDFLARED'],
  ['undeclared', 'FY_CLOUDFLARED'],
];

const PERMISSIONS: Readonly<Record<string, Permissions>> = {
  declared: {
    which: true,
    whichOverrides: ['FY_CLOUDFLARED', 'FY_UNSET', 'FY_RELATIVE', 'FY_WRONG_NAME', 'FY_MISSING'],
  },
  wildcard: { which: true, whichOverrides: ['*'] },
  'overrides-only': { whichOverrides: ['FY_CLOUDFLARED'] },
};

describe('K13 parity: the real host and the testing host locate alike', () => {
  test('every case answers the same on both hosts, and as the rule says', async () => {
    const parent = await folder();
    await mkdir(`${parent}/opt`);
    await mkdir(`${parent}/bin`);
    for (const path of [`${parent}/opt/cloudflared`, `${parent}/bin/cloudflared`, `${parent}/bin/sh`]) {
      await writeFile(path, '#!/bin/sh\n');
      await chmod(path, 0o755);
    }
    const variables: Readonly<Record<string, string>> = {
      FY_CLOUDFLARED: `${parent}/opt/cloudflared`,
      FY_RELATIVE: 'opt/cloudflared',
      FY_WRONG_NAME: `${parent}/bin/sh`,
      FY_MISSING: `${parent}/gone/cloudflared`,
      FY_UNDECLARED: `${parent}/opt/cloudflared`,
      HOME: `${parent}/opt/cloudflared`,
    };
    const ids = ['declared', 'wildcard', 'overrides-only', 'undeclared'];

    const realSeen: Record<string, (override: string) => Promise<CommandLocation>> = {};
    const home = `${parent}/home`;
    const read: string[] = [];
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        searchPath: () => `${parent}/bin`,
        operatorVariable: name => {
          read.push(name);
          return variables[name];
        },
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
      },
      implementations: ids.map(id => locator(id, realSeen, PERMISSIONS[id])),
    });
    const real: Answer[] = [];
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      for (const [id, variable] of CASES) real.push(await answer(() => realSeen[id]?.(variable) ?? Promise.reject()));
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
    }

    const testSeen: Record<string, (override: string) => Promise<CommandLocation>> = {};
    const host = await testHost({
      plugins: ids.map(id => locator(id, testSeen, PERMISSIONS[id])),
      searchPath: `${parent}/bin`,
      operatorVariables: variables,
      executables: [`${parent}/opt/cloudflared`, `${parent}/bin/cloudflared`, `${parent}/bin/sh`, 'opt/cloudflared'],
    });
    const testing: Answer[] = [];
    for (const [id, variable] of CASES) testing.push(await answer(() => testSeen[id]?.(variable) ?? Promise.reject()));
    await host.stop();

    expect(testing).toEqual(real);
    expect(real).toEqual([
      { kind: 'found', path: `${parent}/opt/cloudflared`, via: 'override' },
      { kind: 'found', path: `${parent}/bin/cloudflared`, via: 'path' },
      { kind: 'override_unusable', variable: 'FY_RELATIVE', path: 'opt/cloudflared' },
      { kind: 'override_unusable', variable: 'FY_WRONG_NAME', path: `${parent}/bin/sh` },
      { kind: 'override_unusable', variable: 'FY_MISSING', path: `${parent}/gone/cloudflared` },
      {
        refused:
          'declared asked for an override variable its permissions.whichOverrides does not declare, so it reads no override.',
      },
      {
        refused:
          'declared asked for an override variable its permissions.whichOverrides does not declare, so it reads no override.',
      },
      {
        refused:
          'wildcard asked for an override variable its permissions.whichOverrides does not declare, so it reads no override.',
      },
      { refused: 'overrides-only did not declare permissions.which, so it looks no command up.' },
      { refused: 'undeclared did not declare permissions.which, so it looks no command up.' },
    ]);
    // The real host read the operator's environment for the declared variables alone, never HOME or the undeclared one.
    expect([...new Set(read)].sort()).toEqual([
      'FY_CLOUDFLARED',
      'FY_MISSING',
      'FY_RELATIVE',
      'FY_UNSET',
      'FY_WRONG_NAME',
    ]);
  });
});
