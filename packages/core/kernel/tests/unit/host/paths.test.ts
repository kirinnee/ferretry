import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bindProgram, checkDirectory, gatedPaths } from '../../../host/paths.ts';
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

describe('bindProgram installed-client trust', () => {
  function installed() {
    const entry = (kind: 'file' | 'directory', inode: bigint) => ({
      kind,
      device: 1n,
      inode,
      links: 1,
      size: 17,
      mtimeMs: 1_000,
      mtimeNs: 1_000_000_000n,
      ctimeNs: 2_000_000_000n,
      mode: 0o755,
      owner: 0,
      group: 0,
    });
    const files = new Map([
      ['/', entry('directory', 1n)],
      ['/installed', entry('directory', 2n)],
      ['/installed/fy', entry('file', 3n)],
      ['/usr', entry('directory', 4n)],
      ['/usr/bin', entry('directory', 5n)],
      ['/usr/bin/stat', entry('file', 6n)],
    ]);
    const writable = new Set<string>();
    const fs = {
      realpath: async (path: string) => (path === '/alias/fy' ? '/installed/fy' : path),
      identity: async (path: string) => files.get(path),
      writable: async (path: string) => writable.has(path),
    };
    return { fs, files, writable };
  }

  test('pins the canonical installed client and a trusted absolute identity verifier without executing either', async () => {
    const { fs } = installed();
    expect(await bindProgram(fs, '/alias/fy')).toMatchObject({
      program: '/installed/fy',
      check: { expected: '1:3:17:1:2:0:755' },
    });
    const bound = await bindProgram(fs, '/alias/fy');
    expect(bound?.check.argv[0]).toBe('/usr/bin/stat');
    expect(bound?.check.argv.at(-1)).toBe('/installed/fy');
  });

  test('refuses a writable client or any writable ancestor, including an ACL write grant', async () => {
    for (const path of ['/installed/fy', '/installed', '/usr/bin/stat', '/usr/bin', '/']) {
      const { fs, writable } = installed();
      writable.add(path);
      expect(await bindProgram(fs, '/installed/fy')).toBeUndefined();
    }
  });

  test('refuses a same-user readonly file (its owner can chmod it) and a group writable ancestor', async () => {
    const { fs, files } = installed();
    files.get('/installed/fy')!.owner = 1000;
    expect(await bindProgram(fs, '/installed/fy')).toBeUndefined();
    files.get('/installed/fy')!.owner = 0;
    files.get('/installed')!.mode = 0o775;
    expect(await bindProgram(fs, '/installed/fy')).toBeUndefined();
  });

  test('allows a root-owned sticky Nix-store ancestor only when the pane user cannot write there', async () => {
    const { fs, files, writable } = installed();
    files.get('/installed')!.mode = 0o1775;
    expect((await bindProgram(fs, '/installed/fy'))?.program).toBe('/installed/fy');
    writable.add('/installed');
    expect(await bindProgram(fs, '/installed/fy')).toBeUndefined();
  });

  test('a changed identity during the bind or an unreadable chain proves nothing', async () => {
    const { fs } = installed();
    let looks = 0;
    expect(
      await bindProgram(
        {
          ...fs,
          identity: async path => {
            const found = await fs.identity(path);
            if (path === '/installed/fy' && ++looks > 1 && found) return { ...found, inode: 99n };
            return found;
          },
        },
        '/installed/fy',
      ),
    ).toBeUndefined();
    expect(
      await bindProgram(
        {
          ...fs,
          writable: async () => {
            throw new Error('unreadable');
          },
        },
        '/installed/fy',
      ),
    ).toBeUndefined();
  });

  test('a real agent-writable temporary client is refused', async () => {
    const parent = await folder();
    await writeFile(`${parent}/fy`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await bindProgram(disk, `${parent}/fy`)).toBeUndefined();
  });
});

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
    bindProgram: async () => undefined,
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
