import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
async function fixture() {
  const parent = await mkdtemp(`${tmpdir()}/scoped-root-r1b-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const agentHomes = `${home}/state/claude-code/agent-homes`;
  const outside = `${parent}/outside`;
  await mkdir(agentHomes, { recursive: true, mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID());
  const root = (subfolder: string, adapter = fs) =>
    rootsPortFor(
      adapter,
      { home, plugin: 'claude-code', worktrees: `${home}-worktrees` },
      ['agent-homes'],
      () => undefined,
    ).root('agent-homes', { subfolder });
  return { home, agentHomes, outside, fs, root };
}
const resolved = (root: ReturnType<Awaited<ReturnType<typeof fixture>>['root']>, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

describe('scoped internal roots on a real temporary filesystem', () => {
  for (const target of ['sibling', 'outside'] as const) {
    test(`S42 a scoped base linked to a ${target} directory refuses every operation and changes nothing`, async () => {
      const f = await fixture();
      const destination = target === 'sibling' ? `${f.agentHomes}/f2` : f.outside;
      if (target === 'sibling') await mkdir(destination, { mode: 0o700 });
      await writeFile(`${destination}/memory.md`, 'other-home-fixture');
      await symlink(destination, `${f.agentHomes}/f1`);
      const root = f.root('f1');
      const file = resolved(root, 'memory.md');
      const folder = resolved(root, '');
      await expect(root.readText(file)).rejects.toEqual(new RootError('link_escape'));
      await expect(root.readBytes(file)).rejects.toEqual(new RootError('link_escape'));
      await expect(root.writeText(file, 'must-not-land')).rejects.toEqual(new RootError('link_escape'));
      await expect(root.list(folder)).rejects.toEqual(new RootError('link_escape'));
      await expect(root.stat(file)).rejects.toEqual(new RootError('link_escape'));
      await expect(root.remove(folder)).rejects.toEqual(new RootError('link_escape'));
      expect(await readFile(`${destination}/memory.md`, 'utf8')).toBe('other-home-fixture');
      expect(await readdir(destination)).toEqual(['memory.md']);
      expect((await lstat(`${f.agentHomes}/f1`)).isSymbolicLink()).toBe(true);
    });
  }

  test('S42 a first write creates only its missing scoped base under the verified parent, with private modes', async () => {
    const f = await fixture();
    expect(await readdir(f.agentHomes)).toEqual([]);
    const root = f.root('fresh');
    const path = resolved(root, 'memory.md');
    await root.writeText(path, 'own-home-fixture');
    expect(await root.readText(path)).toBe('own-home-fixture');
    expect(await readFile(`${f.agentHomes}/fresh/memory.md`, 'utf8')).toBe('own-home-fixture');
    expect((await lstat(`${f.agentHomes}/fresh`)).mode & 0o777).toBe(0o700);
    expect((await lstat(`${f.agentHomes}/fresh/memory.md`)).mode & 0o777).toBe(0o600);
    expect(await readdir(f.agentHomes)).toEqual(['fresh']);
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S42 nested missing scope segments use the same verified private creation path', async () => {
    const f = await fixture();
    const root = f.root('group/fresh');
    await root.writeText(resolved(root, 'settings/launch.json'), '{"fixture":true}');
    expect((await lstat(`${f.agentHomes}/group`)).mode & 0o777).toBe(0o700);
    expect((await lstat(`${f.agentHomes}/group/fresh`)).mode & 0o777).toBe(0o700);
    expect(await root.readText(resolved(root, 'settings/launch.json'))).toBe('{"fixture":true}');
  });

  test('S42 creation refuses a substituted parent and a forged path before making any directory', async () => {
    const f = await fixture();
    const root = f.root('fresh');
    await expect(root.writeText(`${f.agentHomes}/other/memory.md` as FencedPath, 'must-not-land')).rejects.toEqual(
      new RootError('outside'),
    );
    expect(await readdir(f.agentHomes)).toEqual([]);
    await rm(f.agentHomes, { recursive: true });
    await symlink(f.outside, f.agentHomes);
    await expect(root.writeText(resolved(root, 'memory.md'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S42 a link swapped in at the new scoped directory open is refused without following it', async () => {
    const f = await fixture();
    let swapped = false;
    const fs = {
      ...f.fs,
      mkdir: async (path: string, mode: number) => {
        await f.fs.mkdir(path, mode);
        if (!swapped) {
          swapped = true;
          await rm(`${f.agentHomes}/fresh`, { recursive: true });
          await symlink(f.outside, `${f.agentHomes}/fresh`);
        }
      },
    };
    const root = f.root('fresh', fs);
    await expect(root.writeText(resolved(root, 'memory.md'), 'must-not-land')).rejects.toEqual(
      new RootError('changed'),
    );
    expect(swapped).toBe(true);
    expect(await readdir(f.outside)).toEqual([]);
  });
});
