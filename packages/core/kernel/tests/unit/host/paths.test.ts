import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { checkDirectory, gatedPaths } from '../../../host/paths.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

/** `kernel.paths.checkDirectory`: today's session working-directory resolver, rule for rule and sentence for sentence. */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const disk = nodeFs(() => 'r');
const folder = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-paths-`));
  parents.push(parent);
  return parent;
};

describe('checkDirectory', () => {
  test('answers the real path of a directory', async () => {
    const parent = await folder();
    await mkdir(`${parent}/work`);

    expect(await checkDirectory(disk, `${parent}/work`)).toEqual({ ok: true, value: { realPath: `${parent}/work` } });
  });

  test('resolves a link and trims what the client typed', async () => {
    const parent = await folder();
    await mkdir(`${parent}/work`);
    await symlink(`${parent}/work`, `${parent}/alias`);

    expect(await checkDirectory(disk, `  ${parent}/alias  `)).toEqual({
      ok: true,
      value: { realPath: `${parent}/work` },
    });
  });

  test('refuses a relative path rather than resolving it against the daemon', async () => {
    expect(await checkDirectory(disk, 'work')).toEqual({
      ok: false,
      error: { reason: 'not_absolute', message: 'session working directory must be absolute: "work"' },
    });
  });

  test('refuses a path that does not exist, here, where the client still sees it', async () => {
    const parent = await folder();

    expect(await checkDirectory(disk, `${parent}/missing`)).toEqual({
      ok: false,
      error: { reason: 'not_a_directory', message: `session working directory is not a directory: ${parent}/missing` },
    });
  });

  test('refuses a file, and a link to a file', async () => {
    const parent = await folder();
    await writeFile(`${parent}/file`, 'x');
    await symlink(`${parent}/file`, `${parent}/alias`);

    for (const path of [`${parent}/file`, `${parent}/alias`])
      expect(await checkDirectory(disk, path)).toEqual({
        ok: false,
        error: { reason: 'not_a_directory', message: `session working directory is not a directory: ${path}` },
      });
  });

  test('creates nothing', async () => {
    const parent = await folder();
    await checkDirectory(disk, `${parent}/new/deeper`);

    expect(await Bun.file(`${parent}/new`).exists()).toBe(false);
  });
});

describe('TT kernel.paths.checkDirectory is gated by permissions.checkDirectory', () => {
  const base = {
    home: () => '/h',
    checkDirectory: async () => ({ ok: true as const, value: { realPath: '/x' } }),
    bindDirectory: async () => ({
      ok: true as const,
      value: { realPath: '/x', insideStateHome: false, verify: async () => ({ ok: true as const, value: undefined }) },
    }),
    stateHomeHolding: async () => undefined,
    which: async () => undefined,
    locate: async () => ({ kind: 'absent' as const }),
    whichFor: async () => ({ kind: 'unprovable' as const }),
  };

  test('a declared plugin is answered; an undeclared one is refused naming the plugin', async () => {
    expect(await gatedPaths('ferrets', true, base).checkDirectory('/x')).toEqual({
      ok: true,
      value: { realPath: '/x' },
    });
    await expect(gatedPaths('stranger', false, base).checkDirectory('/home/me/.ssh')).rejects.toThrow(
      'stranger did not declare permissions.checkDirectory',
    );
    expect(gatedPaths('stranger', false, base).home()).toBe('/h');
  });

  test('the test host mirrors the real host: only a manifest that declares it can probe', async () => {
    const seen: Record<string, () => Promise<unknown>> = {};
    const half = (id: string, checkDirectory?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(checkDirectory === undefined ? {} : { permissions: { checkDirectory } }),
        }),
        {
          build: ctx => {
            seen[id] = () => ctx.kernel.paths.checkDirectory('/work/a');
            return {};
          },
        },
      );
    const host = await testHost({
      plugins: [half('declared', true), half('undeclared')],
      directories: { '/work/a': '/real/a' },
    });
    expect(await seen.declared?.()).toEqual({ ok: true, value: { realPath: '/real/a' } });
    await expect(seen.undeclared?.() ?? Promise.resolve()).rejects.toThrow(
      'undeclared did not declare permissions.checkDirectory',
    );
    await host.stop();
  });
  test('the REAL host hands a plugin the gated paths: a declared one probes, an undeclared one is refused', async () => {
    const seen: Record<string, () => Promise<unknown>> = {};
    const half = (id: string, checkDirectory?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(checkDirectory === undefined ? {} : { permissions: { checkDirectory } }),
        }),
        {
          build: ({ kernel }) => {
            seen[id] = () => kernel.paths.checkDirectory('/');
            return {};
          },
        },
      );
    const root = await mkdtemp(`${tmpdir()}/paths-real-host-`);
    const home = `${root}/home`;
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
      },
      implementations: [half('declared', true), half('undeclared')],
    });
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      expect(await seen.declared?.()).toMatchObject({ ok: true });
      await expect(seen.undeclared?.() ?? Promise.resolve()).rejects.toThrow(
        'undeclared did not declare permissions.checkDirectory',
      );
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
