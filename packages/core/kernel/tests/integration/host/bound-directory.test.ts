/**
 * `bindDirectory` (the kernel behind `PathsPort.bindDirectory`) on the real disk: a launch folder's identity — its real
 * path, its device and inode, and whether it lies inside the state home — is captured when the folder is checked and
 * re-verified immediately before it is used, failing closed on any change or doubt. The late swap that audit A found
 * (a project folder renamed away and replaced by a link into the state home AFTER the start-time check still launched
 * there) is the regression.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { bindDirectory } from '../../../host/bound-directory.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface Fixture {
  readonly parent: string;
  readonly home: string;
  readonly project: string;
  readonly bind: (path: string, fs?: HostFs) => ReturnType<typeof bindDirectory>;
}

async function fixture(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-bound-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/vault`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/vault/vault.key`, 'protected-fixture');
  const project = `${parent}/project`;
  await mkdir(project, { recursive: true });
  return {
    parent,
    home,
    project,
    bind: async (path, fs = nodeFs(() => 'x')) => await bindDirectory(fs, home, { files: [], recheckMs: 0 }, path),
  };
}

async function bound(f: Fixture, path: string, fs?: HostFs) {
  const result = await f.bind(path, fs);
  if (!result.ok) throw new Error(`refused: ${result.error.reason}`);
  return result.value;
}

describe('bindDirectory: capture', () => {
  test('a project folder outside the home is bound with its real path and is not inside the state home', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    expect(folder.realPath).toBe(f.project);
    expect(folder.insideStateHome).toBe(false);
  });

  test('a symlinked project root that stays outside the state home binds to its target and verifies', async () => {
    const f = await fixture();
    await mkdir(`${f.parent}/elsewhere/real-project`, { recursive: true });
    await symlink(`${f.parent}/elsewhere/real-project`, `${f.parent}/code-link`);
    const folder = await bound(f, `${f.parent}/code-link`);
    expect(folder.realPath).toBe(`${f.parent}/elsewhere/real-project`);
    expect(folder.insideStateHome).toBe(false);
    expect((await folder.verify()).ok).toBe(true);
  });

  test('a folder inside the state home is bound and says so (the caller decides who may start there)', async () => {
    const f = await fixture();
    const folder = await bound(f, `${f.home}/state`);
    expect(folder.insideStateHome).toBe(true);
    expect((await folder.verify()).ok).toBe(true);
  });

  test('the home itself and a folder reached through a link that lives in the home are inside it', async () => {
    const f = await fixture();
    expect((await bound(f, f.home)).insideStateHome).toBe(true);
    await symlink(f.project, `${f.home}/state/out-link`);
    expect((await bound(f, `${f.home}/state/out-link`)).insideStateHome).toBe(true);
  });

  test('a folder reached through a link INTO the state home is inside it', async () => {
    const f = await fixture();
    await symlink(`${f.home}/state`, `${f.parent}/sneaky`);
    const folder = await bound(f, `${f.parent}/sneaky`);
    expect(folder.insideStateHome).toBe(true);
    expect(folder.realPath).toBe(`${f.home}/state`);
  });

  test('a relative path, a missing folder and a file are refused as checkDirectory refuses them', async () => {
    const f = await fixture();
    const relative = await f.bind('project');
    expect(!relative.ok && relative.error.reason).toBe('not_absolute');
    const missing = await f.bind(`${f.parent}/nope`);
    expect(!missing.ok && missing.error.reason).toBe('not_a_directory');
    await writeFile(`${f.parent}/file`, 'x');
    const file = await f.bind(`${f.parent}/file`);
    expect(!file.ok && file.error.reason).toBe('not_a_directory');
  });

  test('a home that cannot be identified fails closed: nothing is bound', async () => {
    const f = await fixture();
    await rm(f.home, { recursive: true });
    const result = await f.bind(f.project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('unresolved');
  });
});

describe('bindDirectory: re-verify right before use', () => {
  test('unchanged: verify passes, as often as it is asked', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    expect((await folder.verify()).ok).toBe(true);
    expect((await folder.verify()).ok).toBe(true);
  });

  test('THE LATE SWAP: the folder renamed away and replaced by a link into the state home is held', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    expect(folder.insideStateHome).toBe(false);
    await rename(f.project, `${f.project}-aside`);
    await symlink(`${f.home}/state`, f.project);
    const again = await folder.verify();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('changed');
  });

  test('a late swap for a link to ANY other folder is held too, not only to the state home', async () => {
    const f = await fixture();
    await mkdir(`${f.parent}/other`);
    const folder = await bound(f, f.project);
    await rename(f.project, `${f.project}-aside`);
    await symlink(`${f.parent}/other`, f.project);
    expect((await folder.verify()).ok).toBe(false);
  });

  test('a late swap for a DIFFERENT directory at the same name is held (same path, other inode)', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    await rename(f.project, `${f.project}-aside`);
    await mkdir(f.project);
    const again = await folder.verify();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('changed');
  });

  test('a symlinked root whose link is re-pointed after the check is held', async () => {
    const f = await fixture();
    await mkdir(`${f.parent}/a`);
    await mkdir(`${f.parent}/b`);
    await symlink(`${f.parent}/a`, `${f.parent}/link`);
    const folder = await bound(f, `${f.parent}/link`);
    await rm(`${f.parent}/link`);
    await symlink(`${f.parent}/b`, `${f.parent}/link`);
    expect((await folder.verify()).ok).toBe(false);
  });

  test('a folder removed after the check is held', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    await rm(f.project, { recursive: true });
    expect((await folder.verify()).ok).toBe(false);
  });

  test('a doubt at verify (the disk cannot answer) is held, never passed and never thrown', async () => {
    const f = await fixture();
    const disk = nodeFs(() => 'x');
    let failing = false;
    const fs: HostFs = {
      ...disk,
      identity: async path => {
        if (failing) throw new Error('EIO');
        return await disk.identity(path);
      },
    };
    const folder = await bound(f, f.project, fs);
    failing = true;
    const again = await folder.verify();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(['unresolved', 'changed']).toContain(again.error.reason);
  });

  test('a fence that cannot be computed at verify is held as unresolved', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    await rm(f.home, { recursive: true });
    const again = await folder.verify();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('unresolved');
  });

  test('the refusal names the folder and says nothing was started, and carries no file content', async () => {
    const f = await fixture();
    const folder = await bound(f, f.project);
    await rm(f.project, { recursive: true });
    const again = await folder.verify();
    if (again.ok) throw new Error('expected a refusal');
    expect(again.error.message).toContain(f.project);
    expect(again.error.message).not.toContain('protected-fixture');
  });
});
