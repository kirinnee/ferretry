/**
 * `RootsPort.harnessFile` on the real disk (§7.7, kernel batch #2 part 2; report gap #5 of cfg-writeall): ONE
 * read-only file beside a harness home (`~/.claude.json` sits BESIDE `~/.claude`, so no `harness-home` scope reaches
 * it). Only for Runtimes with `harness-home` declared and the basename in `permissions.harnessFiles`; never in the
 * fence; never a link, a hard-linked file or a device; and its folder is never listable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const PLANTED = '{"mcpServers":{"planted":{"command":"x"}}}\n';
const SSH_KEY = 'planted-private-key-material';

async function fresh() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/harness-file-`));
  parents.push(parent);
  const home = `${parent}/owner/.state-home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.ssh`, { recursive: true, mode: 0o700 });
  await writeFile(`${owner}/.claude.json`, PLANTED, { mode: 0o600 });
  await writeFile(`${owner}/.ssh/id`, SSH_KEY, { mode: 0o600 });
  const port = (
    plugin = 'runtimes',
    declared: readonly RootName[] = ['harness-home'],
    harnessFiles: readonly string[] | null = ['.claude.json'],
    fs: HostFs = nodeFs(() => crypto.randomUUID()),
  ) =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => undefined, {
      ...(harnessFiles === null ? {} : { harnessFiles }),
    });
  return { parent, home, owner, port };
}

function refusalOfSync(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

describe('RootsPort.harnessFile', () => {
  test('reads ~/.claude.json beside the harness home, through one held descriptor', async () => {
    const f = await fresh();
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(file.name).toBe('harness-home');
    expect(file.path).toBe(`${f.owner}/.claude.json`);
    expect(await file.readText()).toBe(PLANTED);
    expect(new TextDecoder().decode(await file.readBytes({ offset: 2, length: 10 }))).toBe(PLANTED.slice(2, 12));
    expect((await file.stat())?.kind).toBe('file');
    expect((await file.lstat())?.links).toBe(1);
    const identity = await file.fileIdentity();
    expect(identity).toBeDefined();
    const held = await file.readDurable(undefined, async read => ({
      text: new TextDecoder().decode(read.bytes),
      still: await read.stillNames(),
      same: read.identity.inode === identity?.inode,
    }));
    expect(held).toEqual({ text: PLANTED, still: true, same: true });
  });

  test('a missing file reads as absent, never as another file', async () => {
    const f = await fresh();
    await unlink(`${f.owner}/.claude.json`);
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(await file.stat()).toBeUndefined();
    expect(await file.lstat()).toBeUndefined();
    expect(await file.fileIdentity()).toBeUndefined();
    expect(await file.readDurable()).toBeUndefined();
    await expect(file.readText()).rejects.toThrow();
  });

  test('an undeclared basename, a wildcard or a path in the names, and an absent list are refused', async () => {
    const f = await fresh();
    expect(refusalOfSync(() => f.port().harnessFile(`${f.owner}/.ssh/id`))).toBe('not_declared');
    expect(
      refusalOfSync(() => f.port('runtimes', ['harness-home'], ['*']).harnessFile(`${f.owner}/.claude.json`)),
    ).toBe('not_declared');
    expect(refusalOfSync(() => f.port('runtimes', ['harness-home'], ['*']).harnessFile(`${f.owner}/.ssh/id`))).toBe(
      'not_declared',
    );
    expect(
      refusalOfSync(() => f.port('runtimes', ['harness-home'], ['.ssh/id']).harnessFile(`${f.owner}/.ssh/id`)),
    ).toBe('not_declared');
    expect(refusalOfSync(() => f.port('runtimes', ['harness-home'], null).harnessFile(`${f.owner}/.claude.json`))).toBe(
      'not_declared',
    );
  });

  test('only Runtimes, and only with harness-home declared', async () => {
    const f = await fresh();
    expect(refusalOfSync(() => f.port('claude-code').harnessFile(`${f.owner}/.claude.json`))).toBe('not_declared');
    expect(refusalOfSync(() => f.port('runtimes', ['fleet']).harnessFile(`${f.owner}/.claude.json`))).toBe(
      'not_declared',
    );
  });

  test('a relative, unnormalized, `..`, NUL or folder-less path is refused before the disk is asked', async () => {
    const f = await fresh();
    const port = f.port('runtimes', ['harness-home'], ['.claude.json', '.ssh']);
    for (const path of [
      '.claude.json',
      `${f.owner}/./.claude.json`,
      `${f.owner}//.claude.json`,
      `${f.owner}/.claude/../.claude.json`,
      `${f.owner}/.claude.json/`,
      `${f.owner}/.claude.json\0`,
      '/',
    ])
      expect(refusalOfSync(() => port.harnessFile(path))).toBe('outside');
  });

  test('a path in the fence is refused, by name and through a link to it', async () => {
    const f = await fresh();
    await writeFile(`${f.home}/config/.claude.json`, '{}');
    expect(refusalOfSync(() => f.port().harnessFile(`${f.home}/config/.claude.json`))).toBe('fenced');
    await symlink(`${f.home}/config`, `${f.owner}/alias`);
    const via = f.port().harnessFile(`${f.owner}/alias/.claude.json`);
    expect(await refusalOf(() => via.readText())).toBe('fenced');
  });

  test('a symlinked file is refused and never followed, even to a file in the same folder', async () => {
    const f = await fresh();
    await unlink(`${f.owner}/.claude.json`);
    await symlink(`${f.owner}/.ssh/id`, `${f.owner}/.claude.json`);
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(await refusalOf(() => file.readText())).toBe('link_escape');
    expect(await refusalOf(() => file.readDurable())).toBe('link_escape');
    expect((await file.lstat())?.kind).toBe('symlink');
    expect(await file.stat()).toBeUndefined();
  });

  test('a file with two hard links is refused', async () => {
    const f = await fresh();
    await unlink(`${f.owner}/.claude.json`);
    await link(`${f.owner}/.ssh/id`, `${f.owner}/.claude.json`);
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(await refusalOf(() => file.readText())).toBe('hard_link');
    expect(await refusalOf(() => file.readBytes())).toBe('hard_link');
  });

  test('a device or a pipe at the name is refused before it is opened', async () => {
    const f = await fresh();
    await unlink(`${f.owner}/.claude.json`);
    const made = spawnSync('mkfifo', [`${f.owner}/.claude.json`]);
    if (made.status !== 0) return;
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(await refusalOf(() => file.readText())).toBe('device_file');
  });

  test('a link swapped in at the name right after the open is caught: the bytes it reached never come back', async () => {
    const f = await fresh();
    const base = nodeFs(() => crypto.randomUUID());
    let swapped = false;
    const racing: HostFs = {
      ...base,
      openRead: async path => {
        const opened = await base.openRead(path);
        if (!swapped && path.endsWith('/.claude.json')) {
          swapped = true;
          await unlink(`${f.owner}/.claude.json`);
          await symlink(`${f.owner}/.ssh/id`, `${f.owner}/.claude.json`);
        }
        return opened;
      },
    };
    const file = f.port('runtimes', ['harness-home'], ['.claude.json'], racing).harnessFile(`${f.owner}/.claude.json`);
    expect(await refusalOf(() => file.readText())).toBe('changed');
    expect(swapped).toBe(true);
  });

  test('a link swapped in between the look at the name and the open is caught after the open', async () => {
    const f = await fresh();
    const base = nodeFs(() => crypto.randomUUID());
    let swapped = false;
    const racing: HostFs = {
      ...base,
      // `withCheckedFile` asks the real path of the NAME right before it opens: the swap lands exactly there, so what
      // it opens (and proves) is the other file, and only the name's own re-check afterwards can tell.
      realpath: async path => {
        if (!swapped && path === `${f.owner}/.claude.json`) {
          swapped = true;
          await unlink(path);
          await symlink(`${f.owner}/.ssh/id`, path);
        }
        return await base.realpath(path);
      },
    };
    const file = f.port('runtimes', ['harness-home'], ['.claude.json'], racing).harnessFile(`${f.owner}/.claude.json`);
    expect(await refusalOf(() => file.readText())).toBe('changed');
    expect(swapped).toBe(true);
  });

  test('the handle names that one file: no listing, no write, no other name', async () => {
    const f = await fresh();
    const file = f.port().harnessFile(`${f.owner}/.claude.json`);
    expect(Object.keys(file).sort()).toEqual(
      ['fileIdentity', 'lstat', 'name', 'path', 'readBytes', 'readDurable', 'readText', 'stat'].sort(),
    );
    expect(Object.isFrozen(file)).toBe(true);
    expect(JSON.stringify(await file.readText())).not.toContain(SSH_KEY);
  });
});
