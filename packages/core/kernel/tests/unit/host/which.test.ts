import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeExecutableProbe } from '../../../host/adapters/executable.ts';
import { bootHost } from '../../../host/host.ts';
import { gatedWhich } from '../../../host/paths.ts';
import { MAX_SEARCH_DIRECTORIES, searchDirectories, whichCommand } from '../../../host/which.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * `kernel.paths.which`: a bare command name to a path under the kernel's control — a bounded search of absolute
 * folders, no shell, nothing executed, the answer a path or absent — and only for a plugin that declares it.
 */
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const folder = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-which-`));
  parents.push(parent);
  return parent;
};

/** A probe that records every path it is asked about and accepts only `accepted`. */
const recording = (accepted: readonly string[] = []) => {
  const asked: string[] = [];
  return {
    asked,
    probe: async (path: string) => (asked.push(path), accepted.includes(path)),
  };
};

describe('which: the name', () => {
  test('a path, a relative name, shell syntax, `.`/`..`, an empty or over-long name is never looked up', async () => {
    for (const name of [
      '/bin/sh',
      './npx',
      'bin/npx',
      '..',
      '.',
      '',
      'a b',
      'npx;rm',
      '$(id)',
      '-rf',
      'x'.repeat(129),
    ]) {
      const { asked, probe } = recording(['/usr/bin/sh']);
      expect({ name, found: await whichCommand(name, { path: '/usr/bin' }, probe) }).toEqual({
        name,
        found: undefined,
      });
      expect({ name, asked }).toEqual({ name, asked: [] });
    }
    // untyped callers: never a guess
    expect(await whichCommand(42 as unknown as string, { path: '/usr/bin' }, async () => true)).toBeUndefined();
  });

  test('an ordinary command name is looked up', async () => {
    for (const name of ['npx', 'uvx', 'node', 'docker', 'python3.12', 'g++', 'claude', 'my_tool-2']) {
      const { probe } = recording([`/usr/bin/${name}`]);
      expect(await whichCommand(name, { path: '/usr/bin' }, probe)).toBe(`/usr/bin/${name}`);
    }
  });
});

describe('which: the search is bounded and absolute', () => {
  test('the caller’s folders come first, then PATH; the first the probe accepts wins', async () => {
    const { asked, probe } = recording(['/opt/b/npx', '/usr/bin/npx']);
    expect(await whichCommand('npx', { path: '/usr/bin:/opt/b', directories: ['/opt/a', '/opt/b'] }, probe)).toBe(
      '/opt/b/npx',
    );
    expect(asked).toEqual(['/opt/a/npx', '/opt/b/npx']);
  });

  test('an empty, relative or odd PATH entry is dropped, never resolved against the daemon’s folder', () => {
    expect(
      searchDirectories('::.:bin:./x:/usr/bin/:/usr//lib:/a/../b:/usr/bin:/ok\0:/', ['relative', '/opt/x']),
    ).toEqual(['/opt/x', '/usr/bin', '/']);
    expect(searchDirectories(undefined)).toEqual([]);
    // untyped directories: nothing searched from them
    expect(searchDirectories('/usr/bin', 'not-a-list' as unknown as readonly string[])).toEqual(['/usr/bin']);
  });

  test(`at most ${MAX_SEARCH_DIRECTORIES} folders are searched, however long PATH is`, async () => {
    const path = Array.from({ length: 500 }, (_, index) => `/d${index}`).join(':');
    const { asked, probe } = recording();
    expect(await whichCommand('npx', { path }, probe)).toBeUndefined();
    expect(asked).toHaveLength(MAX_SEARCH_DIRECTORIES);
  });

  test('a probe that throws passes that candidate over', async () => {
    const found = await whichCommand('npx', { path: '/a:/b' }, async path => {
      if (path === '/a/npx') throw new Error('EACCES');
      return true;
    });
    expect(found).toBe('/b/npx');
  });
});

describe('which: the disk, and nothing executed', () => {
  test('a regular executable file is found; a plain file, a folder and a link to a plain file are not', async () => {
    const parent = await folder();
    await mkdir(`${parent}/bin`);
    await writeFile(`${parent}/bin/ok`, '#!/bin/sh\n');
    await chmod(`${parent}/bin/ok`, 0o755);
    await writeFile(`${parent}/bin/plain`, 'x');
    await chmod(`${parent}/bin/plain`, 0o644);
    await mkdir(`${parent}/bin/folder`, { mode: 0o755 });
    await symlink(`${parent}/bin/ok`, `${parent}/bin/linked`);
    await symlink(`${parent}/bin/plain`, `${parent}/bin/linked-plain`);
    const path = `${parent}/bin`;
    expect(await whichCommand('ok', { path }, nodeExecutableProbe)).toBe(`${parent}/bin/ok`);
    expect(await whichCommand('plain', { path }, nodeExecutableProbe)).toBeUndefined();
    expect(await whichCommand('folder', { path }, nodeExecutableProbe)).toBeUndefined();
    // a link is followed, as a shell follows it, and the answer is the name searched, not the link's target
    expect(await whichCommand('linked', { path }, nodeExecutableProbe)).toBe(`${parent}/bin/linked`);
    expect(await whichCommand('linked-plain', { path }, nodeExecutableProbe)).toBeUndefined();
    expect(await whichCommand('missing', { path }, nodeExecutableProbe)).toBeUndefined();
  });

  test('the command found is never run', async () => {
    const parent = await folder();
    await writeFile(`${parent}/tool`, `#!/bin/sh\ntouch ${parent}/ran\n`);
    await chmod(`${parent}/tool`, 0o755);
    expect(await whichCommand('tool', { path: parent }, nodeExecutableProbe)).toBe(`${parent}/tool`);
    expect(await Bun.file(`${parent}/ran`).exists()).toBe(false);
  });
});

describe('which: gated by permissions.which', () => {
  const base = {
    home: () => '/h',
    checkDirectory: async () => ({ ok: true as const, value: { realPath: '/x' } }),
    which: async () => '/usr/bin/npx',
    locate: async () => ({ kind: 'absent' as const }),
    whichFor: async () => ({ kind: 'unprovable' as const }),
  };

  test('a declared plugin is answered; an undeclared one is refused naming the plugin, its other calls kept', async () => {
    expect(await gatedWhich('runtimes', true, base).which('npx')).toBe('/usr/bin/npx');
    await expect(gatedWhich('stranger', false, base).which('npx')).rejects.toThrow(
      'stranger did not declare permissions.which',
    );
    expect(await gatedWhich('stranger', false, base).checkDirectory('/x')).toMatchObject({ ok: true });
    expect(gatedWhich('stranger', false, base).home()).toBe('/h');
  });

  const half = (id: string, seen: Record<string, (name: string) => Promise<unknown>>, which?: true) =>
    implementDaemon(
      definePlugin({
        id,
        title: id,
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        ...(which === undefined ? {} : { permissions: { which } }),
      }),
      {
        build: ({ kernel }) => {
          seen[id] = name => kernel.paths.which(name, { directories: ['/opt/tools'] });
          return {};
        },
      },
    );

  test('the testing host runs the same lookup over its own world, gated the same way', async () => {
    const seen: Record<string, (name: string) => Promise<unknown>> = {};
    const host = await testHost({
      plugins: [half('declared', seen, true), half('undeclared', seen)],
      searchPath: 'relative:/usr/bin',
      executables: ['/usr/bin/npx', '/opt/tools/uvx', 'relative/node'],
    });
    expect(await seen.declared?.('npx')).toBe('/usr/bin/npx');
    expect(await seen.declared?.('uvx')).toBe('/opt/tools/uvx');
    expect(await seen.declared?.('node')).toBeUndefined();
    expect(await seen.declared?.('/usr/bin/npx')).toBeUndefined();
    await expect(seen.undeclared?.('npx') ?? Promise.resolve()).rejects.toThrow(
      'undeclared did not declare permissions.which',
    );
    await host.stop();
  });

  test('the REAL host searches the daemon’s PATH on the disk for a declared plugin and refuses an undeclared one', async () => {
    const parent = await folder();
    await mkdir(`${parent}/bin`);
    await writeFile(`${parent}/bin/fy-which-probe`, '#!/bin/sh\n');
    await chmod(`${parent}/bin/fy-which-probe`, 0o755);
    const seen: Record<string, (name: string) => Promise<unknown>> = {};
    const home = `${parent}/home`;
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        searchPath: () => `${parent}/bin`,
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
      },
      implementations: [half('declared', seen, true), half('undeclared', seen)],
    });
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      expect(await seen.declared?.('fy-which-probe')).toBe(`${parent}/bin/fy-which-probe`);
      expect(await seen.declared?.('fy-which-absent')).toBeUndefined();
      await expect(seen.undeclared?.('fy-which-probe') ?? Promise.resolve()).rejects.toThrow(
        'undeclared did not declare permissions.which',
      );
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
    }
  });
});
