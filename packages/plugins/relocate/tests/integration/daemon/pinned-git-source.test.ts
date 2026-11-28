import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type KernelPorts, MOVE_SOURCE_GIT_READS } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { bunSpawn } from '../../../../../core/kernel/host/adapters/process.ts';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelWorkingTree } from '../../../daemon/lib/git-bundle.ts';

async function snapshot(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await snapshot(path))) files[`${entry.name}/${name}`] = bytes;
    } else {
      files[entry.name] =
        `${(await stat(path, { bigint: true })).mtimeNs}:${(await readFile(path)).toString('base64')}`;
    }
  }
  return files;
}

test('SEC-K1: the actual Relocate source caller exports through read-only pins without changing a file', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-readonly-source-`));
  const user = `${parent}/user`;
  const folder = `${parent}/project`;
  await mkdir(user);
  await mkdir(folder);
  await mkdir(`${parent}/fy`);
  await writeFile(`${user}/.gitconfig`, '[user]\nname = Fixture\nemail = fixture@example.test\n');
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(['git', ...args], {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: user,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    expect(done.exitCode).toBe(0);
  };
  try {
    git('init', '-b', 'main');
    await writeFile(`${folder}/kept.txt`, 'original\n');
    await writeFile(`${folder}/.gitignore`, 'ignored/\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    await writeFile(`${folder}/kept.txt`, 'changed\n');
    await writeFile(`${folder}/new.txt`, 'new\n');
    await mkdir(`${folder}/ignored`);
    await writeFile(`${folder}/ignored/local.txt`, 'ignored\n');
    const pins = new PinRegistry(() => platformRootPinner());
    const kernel = {
      roots: rootsPortFor(
        nodeFs(() => 'fixture'),
        { home: `${parent}/fy`, plugin: 'relocate', worktrees: `${parent}/worktrees` },
        ['imports'],
        () => undefined,
        { pins },
      ),
      spawn: restrictSpawn(
        'relocate',
        ['git'],
        bunSpawn(
          { PATH: process.env.PATH ?? '', HOME: user },
          undefined,
          {},
          { PATH: process.env.PATH ?? '', HOME: user },
        ),
        undefined,
        pins,
        undefined,
        MOVE_SOURCE_GIT_READS,
      ),
      clock: { nowMs: () => Date.now() } as KernelPorts['clock'],
    };
    const before = await snapshot(folder);
    const source = kernelWorkingTree(kernel, folder);
    expect(await source.head()).toBeDefined();
    expect(await source.remote()).toBeUndefined();
    const patch = await source.changes(1024 * 1024);
    expect(patch.length).toBeGreaterThan(0);
    expect((await source.commits(1024 * 1024))?.length).toBeGreaterThan(0);
    expect(await source.untracked()).toContain('new.txt');
    expect(await source.ignoredTopLevel()).toContain('ignored/');
    let inspected = 0;
    await source.inspect(() => {
      inspected++;
    }, patch);
    expect(inspected).toBeGreaterThan(0);
    expect(await snapshot(folder)).toEqual(before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
