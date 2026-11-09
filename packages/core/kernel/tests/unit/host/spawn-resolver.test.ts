/**
 * `permissions.spawn: [{ resolver }]` (K2): the plugin's own half answers, with nothing about the request, the programs
 * that may start now. An answer must equal the program exactly (`programAmong`: an absolute answer allows only that
 * path, a bare name its basename); `*` allows nothing; a throwing, missing or malformed resolver refuses. The real host
 * and the testing host refuse alike.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts, SpawnPort } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { NO_ITEMS, PermissionError, restrictSpawn, spawnPermitted } from '../../../host/permissions.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

describe('spawnPermitted: a resolver entry allows what its answer names', () => {
  const answering = (...answers: string[]) => ({
    resolve: (name: string) => (name === 'mcp-check' ? () => answers : undefined),
    declared: [{ resolver: 'mcp-check' }],
  });

  test('an absolute answer allows only that exact path, never another file of the same name', () => {
    const { resolve, declared } = answering('/opt/srv/server');
    expect(spawnPermitted(declared, NO_ITEMS, '/opt/srv/server', resolve)).toBe(true);
    expect(spawnPermitted(declared, NO_ITEMS, '/tmp/server', resolve)).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'server', resolve)).toBe(false);
  });

  test('a bare-name answer allows that program by name and by the basename of an absolute path', () => {
    const { resolve, declared } = answering('npx');
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', resolve)).toBe(true);
    expect(spawnPermitted(declared, NO_ITEMS, '/usr/bin/npx', resolve)).toBe(true);
    expect(spawnPermitted(declared, NO_ITEMS, 'npm', resolve)).toBe(false);
  });

  test('a wildcard answer allows nothing, and a pattern in an answer is dropped beside its good neighbours', () => {
    const { resolve, declared } = answering('*', 'np*', '', 'npx');
    expect(spawnPermitted(declared, NO_ITEMS, 'rm', resolve)).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npm', resolve)).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, '', resolve)).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', resolve)).toBe(true);
  });

  test('a throwing resolver refuses, and so does one that is missing or answers something that is not a list', () => {
    const declared = [{ resolver: 'mcp-check' }];
    const throwing = (): (() => readonly string[]) => () => {
      throw new Error('boom');
    };
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', () => throwing())).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', () => undefined)).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npx')).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', () => () => 'npx' as unknown as readonly string[])).toBe(false);
    expect(spawnPermitted(declared, NO_ITEMS, 'npx', () => () => [7, null, {}] as unknown as readonly string[])).toBe(
      false,
    );
  });

  test('a declared program keeps working beside a resolver that refuses, and the resolver is asked nothing about the call', () => {
    const asked: unknown[][] = [];
    const resolve =
      () =>
      (...args: unknown[]) => {
        asked.push(args);
        throw new Error('boom');
      };
    expect(spawnPermitted(['git', { resolver: 'mcp-check' }], NO_ITEMS, '/usr/bin/git', resolve as never)).toBe(true);
    expect(spawnPermitted(['git', { resolver: 'mcp-check' }], NO_ITEMS, 'rm', resolve as never)).toBe(false);
    expect(asked).toEqual([[]]);
  });

  test('restrictSpawn asks the resolver at each call: a program armed later runs, and one disarmed refuses', async () => {
    let armed: string[] = [];
    const ran: string[] = [];
    const base: SpawnPort = {
      run: async program => {
        ran.push(program);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      runBytes: async () => {
        throw new Error('not run here');
      },
      start: () => {
        throw new Error('not started here');
      },
    };
    const port = restrictSpawn('mcp', [{ resolver: 'mcp-check' }], base, NO_ITEMS, undefined, name =>
      name === 'mcp-check' ? () => armed : undefined,
    );
    await expect(port.run('/opt/srv/server', [])).rejects.toThrow(PermissionError);
    armed = ['/opt/srv/server'];
    await port.run('/opt/srv/server', []);
    armed = [];
    await expect(port.run('/opt/srv/server', [])).rejects.toThrow(
      'mcp may not run server: its manifest does not declare it.',
    );
    expect(ran).toEqual(['/opt/srv/server']);
  });
});

// ─── both hosts, one scenario ─────────────────────────────────────────────────────────────────────────────────────────

interface Seen {
  probing?: KernelPorts;
  ghost?: KernelPorts;
}

type Answers = { current: readonly string[] | 'throw' | 'not-a-list' };

const halves = (seen: Seen, answers: Answers) => [
  implementDaemon(
    definePlugin({
      id: 'probing',
      title: 'Probing',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { spawn: [{ resolver: 'check' }] },
    }),
    {
      build: ({ kernel }) => {
        seen.probing = kernel;
        return {
          resolvers: {
            check: () => {
              if (answers.current === 'throw') throw new Error('boom');
              return answers.current as readonly string[];
            },
          },
        };
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'ghost',
      title: 'Ghost',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { spawn: [{ resolver: 'missing' }] },
    }),
    {
      build: ({ kernel }) => {
        seen.ghost = kernel;
        // a half that declared a resolver and does not implement it: its reach is nothing
        return {} as never;
      },
    },
  ),
];

const attempt = async (ports: KernelPorts | undefined, program: string): Promise<'ok' | 'refused'> =>
  await (ports as KernelPorts).spawn.run(program, []).then(
    () => 'ok' as const,
    () => 'refused' as const,
  );

async function cases(seen: Seen, answers: Answers): Promise<Record<string, 'ok' | 'refused'>> {
  const out: Record<string, 'ok' | 'refused'> = {};
  answers.current = ['/opt/srv/server', 'npx'];
  for (const program of ['/opt/srv/server', '/tmp/server', 'server', 'npx', '/usr/bin/npx', 'rm'])
    out[`exact+bare: ${program}`] = await attempt(seen.probing, program);
  answers.current = ['*'];
  for (const program of ['rm', '*']) out[`wildcard: ${program}`] = await attempt(seen.probing, program);
  answers.current = 'throw';
  out['throwing: npx'] = await attempt(seen.probing, 'npx');
  answers.current = 'not-a-list';
  out['not a list: npx'] = await attempt(seen.probing, 'npx');
  answers.current = ['npx'];
  out['missing resolver: npx'] = await attempt(seen.ghost, 'npx');
  return out;
}

async function onTestingHost() {
  const seen: Seen = {};
  const answers: Answers = { current: [] };
  const host = await testHost({
    plugins: halves(seen, answers),
    spawn: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
  });
  try {
    return await cases(seen, answers);
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-spawn-resolver-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: Seen = {};
  const answers: Answers = { current: [] };
  const spawn: SpawnPort = {
    run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    runBytes: async () => {
      throw new Error('not run here');
    },
    start: () => {
      throw new Error('not started here');
    },
  };
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => undefined, { binary: 'fy' }),
      spawn,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen, answers),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return await cases(seen, answers);
  } finally {
    await outcome.host.stop();
  }
}

describe('K2: a spawn resolver, on the real host and the testing host', () => {
  test('the real host: exact absolute and bare answers, wildcard, throwing, malformed and missing resolvers', async () => {
    expect(await onRealHost()).toEqual({
      'exact+bare: /opt/srv/server': 'ok',
      'exact+bare: /tmp/server': 'refused',
      'exact+bare: server': 'refused',
      'exact+bare: npx': 'ok',
      'exact+bare: /usr/bin/npx': 'ok',
      'exact+bare: rm': 'refused',
      'wildcard: rm': 'refused',
      'wildcard: *': 'refused',
      'throwing: npx': 'refused',
      'not a list: npx': 'refused',
      'missing resolver: npx': 'refused',
    });
  });

  test('the testing host answers every case identically to the real host', async () => {
    expect(await onTestingHost()).toEqual(await onRealHost());
  });
});
