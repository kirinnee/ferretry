/**
 * The writable `project-files` root on the real disk (S179, §7.7, K3): a handle is scoped PER CALL to ONE absolute
 * project folder and to the manifest's declared relative set; every write is a checked, no-follow descriptor write; a
 * link at any level, a hard-linked file and the state-home fence are refused as `work` refuses them. Each case is spelled
 * with temp folders; the refusal is the stable code a plugin meets.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** MCP's file and Skills' folders: the two shapes the root is built for. */
const DECLARED = ['.mcp.json', '.claude/skills/*/**', '.agents/skills/*/**'] as const;

async function fresh(options: { readonly disk?: HostFs; readonly declared?: readonly RootName[] } = {}) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-project-files-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const proj = `${parent}/proj`;
  const other = `${parent}/other`;
  const outside = `${parent}/outside`;
  for (const folder of [`${home}/state`, `${home}/config`, proj, other, outside])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  const disk = options.disk ?? nodeFs(() => crypto.randomUUID());
  /** `null`: the manifest declared the root and no `projectFiles` at all. */
  const port = (
    patterns: readonly string[] | null = DECLARED,
    declared: readonly RootName[] = ['project-files'],
  ): RootsPort =>
    rootsPortFor(disk, { home, plugin: 'mcp', worktrees: `${home}-worktrees` }, declared, () => undefined, {
      random: () => 'rnd',
      setMode: true,
      ...(patterns === null ? {} : { projectFiles: patterns }),
    });
  const roots = port();
  return { parent, home, proj, other, outside, port, root: roots.root('project-files', { subfolder: proj }) };
}

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

/** The refusal a call made, `undefined` when it went through. Anything but a root refusal is a failure of the test. */
async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

describe('S179 the declared relative set', () => {
  test('S179 a write inside the declared set lands: the MCP file and a skill folder at any depth', async () => {
    const f = await fresh();
    await f.root.writeText(at(f.root, '.mcp.json'), '{"mcpServers":{}}\n');
    await f.root.writeText(at(f.root, '.claude/skills/x/SKILL.md'), '# x');
    await f.root.writeText(at(f.root, '.claude/skills/x/a/b/c.md'), 'deep');
    await f.root.writeBytes(at(f.root, '.agents/skills/y/data.bin'), new Uint8Array([1, 2, 3]));
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('{"mcpServers":{}}\n');
    expect(await readFile(`${f.proj}/.claude/skills/x/SKILL.md`, 'utf8')).toBe('# x');
    expect(await readFile(`${f.proj}/.claude/skills/x/a/b/c.md`, 'utf8')).toBe('deep');
    expect(await f.root.readText(at(f.root, '.mcp.json'))).toBe('{"mcpServers":{}}\n');
    expect((await stat(`${f.proj}/.mcp.json`)).mode & 0o777).toBe(0o600);
  });

  test('S179 a write outside the declared set is refused not_declared and nothing lands', async () => {
    const f = await fresh();
    const outside = [
      '.claude/other',
      '.claude/settings.json',
      '.claude/skills/SKILL.md-is-a-file-at-the-grant',
      'package.json',
      '.git/hooks/pre-commit',
      '.mcp.json2',
      '.mcp.json/child',
      '.claude/skillz/x/a',
      'sub/.mcp.json',
    ];
    // a name AT a skill folder is a file where the pattern wants a folder with something in it
    outside.push('.claude/skills/x');
    for (const name of outside) {
      expect(await refusalOf(() => f.root.writeText(at(f.root, name), 'no'))).toBe('not_declared');
      expect(await refusalOf(() => f.root.publish(at(f.root, name), new Uint8Array([1])))).toBe('not_declared');
      expect(await refusalOf(() => f.root.writeText(at(f.root, name), 'no', { exclusive: true }))).toBe('not_declared');
    }
    expect(await readdir(f.proj)).toEqual([]);
  });

  test('S179 a name above a grant is only made or looked at: never listed, written or removed', async () => {
    const f = await fresh();
    await f.root.makeDirectory(at(f.root, '.claude/skills/x'));
    expect(await exists(`${f.proj}/.claude/skills/x`)).toBe(true);
    expect((await f.root.lstat(at(f.root, '.claude/skills')))?.kind).toBe('directory');
    expect((await f.root.stat(at(f.root, '.claude/skills/x')))?.kind).toBe('directory');
    expect(await refusalOf(() => f.root.list(at(f.root, '.claude/skills')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.entries(at(f.root, '.claude')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude/skills')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.makeDirectory(at(f.root, '.claude/other')))).toBe('not_declared');
    // the one MCP name is a file, never a folder
    expect(await refusalOf(() => f.root.makeDirectory(at(f.root, '.mcp.json')))).toBe('not_declared');
    // the project folder itself is never a name of the set
    expect(await refusalOf(() => f.root.list(at(f.root, '')))).toBe('outside');
    expect(await refusalOf(() => f.root.remove(at(f.root, '')))).toBe('outside');
  });

  test('S179 .claude/skills/x alone: no file is written at the grant, the folder is made, listed and removed whole', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x'), 'a file'))).toBe('not_declared');
    await f.root.makeDirectory(at(f.root, '.claude/skills/x'));
    await f.root.writeText(at(f.root, '.claude/skills/x/SKILL.md'), '# x');
    expect(await f.root.list(at(f.root, '.claude/skills/x'))).toEqual(['SKILL.md']);
    await f.root.remove(at(f.root, '.claude/skills/x'));
    expect(await exists(`${f.proj}/.claude/skills/x`)).toBe(false);
    expect(await exists(`${f.proj}/.claude/skills`)).toBe(true);
  });

  test('S179 names are compared exactly: a case trick is not the declared name', async () => {
    const f = await fresh();
    for (const name of ['.MCP.json', '.Mcp.json', '.CLAUDE/skills/x/a', '.claude/Skills/x/a', '.claude/SKILLS/x/a'])
      expect(await refusalOf(() => f.root.writeText(at(f.root, name), 'no'))).toBe('not_declared');
    expect(await readdir(f.proj)).toEqual([]);
  });

  test('S179 a plugin that declared the root but no set reaches no name; an unusable pattern grants nothing', async () => {
    const f = await fresh();
    for (const patterns of [null, [], ['**'], ['*/**'], ['/abs/.mcp.json'], ['../x'], ['.claude/**/x'], ['.mcp*']]) {
      const root = f.port(patterns).root('project-files', { subfolder: f.proj });
      expect(await refusalOf(() => root.writeText(at(root, '.mcp.json'), 'no'))).toBe('not_declared');
      expect(await refusalOf(() => root.writeText(at(root, 'anything/at/all'), 'no'))).toBe('not_declared');
    }
    expect(await readdir(f.proj)).toEqual([]);
  });

  test('S179 .. , an absolute path and NUL are refused before the set is asked', async () => {
    const f = await fresh();
    expect(f.root.resolve('.claude/skills/x/../../../escape')).toEqual({ ok: false, error: 'outside' });
    expect(f.root.resolve('.claude/skills/x/../../skills/x/a')).toEqual({ ok: false, error: 'outside' });
    expect(f.root.resolve('/etc/passwd')).toEqual({ ok: false, error: 'outside' });
    // even an absolute path that names a place inside this very folder is not a relative name
    expect(f.root.resolve(`${f.proj}/.mcp.json`)).toEqual({ ok: false, error: 'outside' });
    expect(f.root.resolve('.mcp.json\0')).toEqual({ ok: false, error: 'outside' });
    // a FencedPath forged past `resolve` meets the same refusals at the call
    for (const forged of [
      `${f.proj}/.claude/skills/x/../../skills/x/a`,
      `${f.proj}/.mcp.json/../.mcp.json`,
      `${f.proj}/../outside/x`,
      '/etc/passwd',
      `${f.proj}/.mcp.json\0`,
    ])
      expect(await refusalOf(() => f.root.writeText(forged as FencedPath, 'no'))).toBe('outside');
    expect(await readdir(f.outside)).toEqual([]);
    expect(await readdir(f.proj)).toEqual([]);
  });
});

describe('S179 scope per call', () => {
  test('S179 each call is scoped to the one absolute folder it names: a second folder never reuses the first', async () => {
    const f = await fresh();
    const roots = f.port();
    const a = roots.root('project-files', { subfolder: f.proj });
    const b = roots.root('project-files', { subfolder: f.other });
    await a.writeText(at(a, '.mcp.json'), 'A');
    await b.writeText(at(b, '.mcp.json'), 'B');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('A');
    expect(await readFile(`${f.other}/.mcp.json`, 'utf8')).toBe('B');
    // a path of A is outside B
    expect(await refusalOf(() => b.writeText(at(a, '.mcp.json'), 'B-wins'))).toBe('outside');
    expect(await refusalOf(() => b.readText(at(a, '.mcp.json')))).toBe('outside');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('A');
  });

  test('S179 a scope that is not one plain absolute folder resolves nothing', async () => {
    const f = await fresh();
    const roots = f.port();
    for (const subfolder of [
      undefined,
      '',
      'proj',
      '/',
      `${f.proj}/`,
      `${f.proj}/../other`,
      `${f.proj}/./`,
      `${f.proj}\0`,
    ]) {
      const root = roots.root('project-files', subfolder === undefined ? undefined : { subfolder });
      expect(root.resolve('.mcp.json')).toEqual({ ok: false, error: 'outside' });
      expect(await refusalOf(() => root.writeText(`${f.proj}/.mcp.json` as FencedPath, 'no'))).toBe('outside');
    }
    expect(await readdir(f.proj)).toEqual([]);
  });

  test('S179 a plugin without project-files in permissions.roots cannot get the handle', async () => {
    const f = await fresh();
    const roots = f.port(DECLARED, ['work', 'downloads']);
    expect(() => roots.root('project-files', { subfolder: f.proj })).toThrow(new RootError('not_declared'));
  });

  test('S179 the handle is an owner root, writable, not kernel-made', async () => {
    const f = await fresh();
    expect(f.root.internal).toBe(false);
    expect(f.root.name).toBe('project-files');
  });
});

describe('S179 links and hard links', () => {
  test('S179 a link at the leaf is refused and never followed, whatever the write asks', async () => {
    const f = await fresh();
    await writeFile(`${f.outside}/target.json`, 'precious');
    await symlink(`${f.outside}/target.json`, `${f.proj}/.mcp.json`);
    for (const options of [undefined, { exclusive: true }, { replaceExisting: true }]) {
      expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no', options))).not.toBeUndefined();
    }
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no'))).toBe('link_escape');
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no', { replaceExisting: true }))).toBe(
      'link_escape',
    );
    expect(await refusalOf(() => f.root.publish(at(f.root, '.mcp.json'), new Uint8Array([1])))).toBe('link_escape');
    expect(await refusalOf(() => f.root.readText(at(f.root, '.mcp.json')))).toBe('link_escape');
    expect(await readFile(`${f.outside}/target.json`, 'utf8')).toBe('precious');
    expect((await lstat(`${f.proj}/.mcp.json`)).isSymbolicLink()).toBe(true);
  });

  test('S179 a dangling link at the leaf is refused, not replaced', async () => {
    const f = await fresh();
    await symlink(`${f.outside}/nowhere.json`, `${f.proj}/.mcp.json`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no'))).toBe('link_escape');
    expect(await refusalOf(() => f.root.publish(at(f.root, '.mcp.json'), new Uint8Array([1])))).toBe('link_escape');
    expect((await lstat(`${f.proj}/.mcp.json`)).isSymbolicLink()).toBe(true);
    expect(await exists(`${f.outside}/nowhere.json`)).toBe(false);
  });

  test('S179 a link at any folder level is refused: out of the folder, or to another place inside it', async () => {
    const f = await fresh();
    // `.claude` is a link to a folder OUTSIDE the project
    await symlink(f.outside, `${f.proj}/.claude`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'no'))).toBe('link_escape');
    expect(await refusalOf(() => f.root.makeDirectory(at(f.root, '.claude/skills/x')))).toBe('link_escape');
    expect(await readdir(f.outside)).toEqual([]);
    await rm(`${f.proj}/.claude`);
    // a skill folder that is a link to ANOTHER place inside the project, which the declared set never reached
    await mkdir(`${f.proj}/src`);
    await mkdir(`${f.proj}/.claude/skills`, { recursive: true });
    await symlink(`${f.proj}/src`, `${f.proj}/.claude/skills/x`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'no'))).toBe('link_escape');
    // a name BELOW the link is refused the same way, remove included
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude/skills/x/a.md')))).toBe('link_escape');
    expect(await readdir(`${f.proj}/src`)).toEqual([]);
    // the link ITSELF is a name of the set: remove never follows the leaf, so it is unlinked as a link and what it
    // pointed at is untouched (rule of the remove-realparent unit, M1 of the K3 review)
    await writeFile(`${f.proj}/src/keep.md`, 'keep');
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude/skills/x')))).toBeUndefined();
    expect(await exists(`${f.proj}/.claude/skills/x`)).toBe(false);
    expect(await readFile(`${f.proj}/src/keep.md`, 'utf8')).toBe('keep');
    // a link in the middle of a deeper name
    await mkdir(`${f.proj}/.claude/skills/y`);
    await symlink(f.outside, `${f.proj}/.claude/skills/y/deep`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/y/deep/a.md'), 'no'))).toBe('link_escape');
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S179 a project folder that is itself reached by a link is judged by where it really is', async () => {
    const f = await fresh();
    await symlink(f.proj, `${f.parent}/proj-alias`);
    const root = f.port().root('project-files', { subfolder: `${f.parent}/proj-alias` });
    await root.writeText(at(root, '.mcp.json'), 'via alias');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('via alias');
  });

  test('S179 a hard-linked target is refused by every write and read; the other name is untouched', async () => {
    const f = await fresh();
    await writeFile(`${f.outside}/secret.txt`, 'secret');
    await chmod(`${f.outside}/secret.txt`, 0o644);
    await link(`${f.outside}/secret.txt`, `${f.proj}/.mcp.json`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no'))).toBe('hard_link');
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'no', { replaceExisting: true }))).toBe(
      'hard_link',
    );
    expect(await refusalOf(() => f.root.publish(at(f.root, '.mcp.json'), new Uint8Array([1])))).toBe('hard_link');
    expect(await refusalOf(() => f.root.readText(at(f.root, '.mcp.json')))).toBe('hard_link');
    expect(await refusalOf(() => f.root.setMode(at(f.root, '.mcp.json'), 0o644))).toBe('hard_link');
    expect(await readFile(`${f.outside}/secret.txt`, 'utf8')).toBe('secret');
    expect((await stat(`${f.outside}/secret.txt`)).mode & 0o777).toBe(0o644);
  });
});

describe('S179 modes and the exclusive write', () => {
  test('S179 replaceExisting keeps the mode of the file it replaces; a fresh write is 0600', async () => {
    const f = await fresh();
    await writeFile(`${f.proj}/.mcp.json`, 'old');
    await chmod(`${f.proj}/.mcp.json`, 0o640);
    await f.root.writeText(at(f.root, '.mcp.json'), 'new', { replaceExisting: true });
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('new');
    expect((await stat(`${f.proj}/.mcp.json`)).mode & 0o777).toBe(0o640);
    await f.root.writeText(at(f.root, '.mcp.json'), 'newer', { replaceExisting: true, mode: 0o600 });
    expect((await stat(`${f.proj}/.mcp.json`)).mode & 0o777).toBe(0o600);
    await f.root.writeText(at(f.root, '.claude/skills/x/SKILL.md'), '# x');
    expect((await stat(`${f.proj}/.claude/skills/x/SKILL.md`)).mode & 0o777).toBe(0o600);
  });

  test('S179 replaceExisting needs a regular file there; exclusive creates only', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.mcp.json'), 'x', { replaceExisting: true }))).toBe(
      'outside',
    );
    await f.root.writeText(at(f.root, '.mcp.json'), 'one', { exclusive: true });
    await expect(f.root.writeText(at(f.root, '.mcp.json'), 'two', { exclusive: true })).rejects.toBeDefined();
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('one');
  });

  test('S179 setMode follows the same set; publish and fileIdentity too', async () => {
    const f = await fresh();
    await f.root.writeText(at(f.root, '.mcp.json'), 'x');
    await f.root.setMode(at(f.root, '.mcp.json'), 0o644);
    expect((await stat(`${f.proj}/.mcp.json`)).mode & 0o777).toBe(0o644);
    await writeFile(`${f.proj}/package.json`, '{}');
    expect(await refusalOf(() => f.root.setMode(at(f.root, 'package.json'), 0o777))).toBe('not_declared');
    expect(await refusalOf(() => f.root.fileIdentity(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.readText(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.readDurable(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.readBytes(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.readTail(at(f.root, 'package.json'), 4))).toBe('not_declared');
    expect(await refusalOf(() => f.root.stat(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.lstat(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await refusalOf(() => f.root.realPath(at(f.root, 'package.json')))).toBe('not_declared');
    expect(await f.root.fileIdentity(at(f.root, '.mcp.json'))).toBeDefined();
    const published = await f.root.publish(at(f.root, '.claude/skills/x/SKILL.md'), new TextEncoder().encode('# x'));
    expect(published.outcome).toBe('published');
    expect(await readFile(`${f.proj}/package.json`, 'utf8')).toBe('{}');
  });
});

describe('S179 the fence', () => {
  test('S179 a project folder inside the state home is refused: nothing is read or written there', async () => {
    const f = await fresh();
    const inside = `${f.home}/state/proj`;
    await mkdir(inside, { recursive: true });
    await writeFile(`${inside}/.mcp.json`, 'inside the fence');
    const root = f.port().root('project-files', { subfolder: inside });
    expect(await refusalOf(() => root.writeText(`${inside}/.mcp.json` as FencedPath, 'no'))).toBe('fenced');
    expect(await refusalOf(() => root.writeText(`${inside}/.claude/skills/x/a` as FencedPath, 'no'))).toBe('fenced');
    expect(await refusalOf(() => root.readText(`${inside}/.mcp.json` as FencedPath))).toBe('fenced');
    expect(root.resolve('.mcp.json')).toEqual({ ok: false, error: 'fenced' });
    expect(await readFile(`${inside}/.mcp.json`, 'utf8')).toBe('inside the fence');
    expect(await exists(`${inside}/.claude`)).toBe(false);
  });

  test('S179 a project folder that is a link INTO the state home is refused by where it really is', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/state/vault`, { recursive: true });
    await symlink(`${f.home}/state/vault`, `${f.parent}/looks-innocent`);
    const root = f.port().root('project-files', { subfolder: `${f.parent}/looks-innocent` });
    expect(await refusalOf(() => root.writeText(`${f.parent}/looks-innocent/.mcp.json` as FencedPath, 'no'))).toBe(
      'fenced',
    );
    expect(await readdir(`${f.home}/state/vault`)).toEqual([]);
  });

  test('S179 a home that cannot be resolved fails closed: nothing is written', async () => {
    const f = await fresh();
    const roots = rootsPortFor(
      nodeFs(() => 'r'),
      { home: `${f.parent}/no-such-home`, plugin: 'mcp', worktrees: `${f.parent}/no-such-home-worktrees` },
      ['project-files'],
      () => undefined,
      { projectFiles: DECLARED },
    );
    const root = roots.root('project-files', { subfolder: f.proj });
    expect(await refusalOf(() => root.writeText(at(root, '.mcp.json'), 'no'))).toBe('fenced');
    expect(await readdir(f.proj)).toEqual([]);
  });
});

describe('S179 descriptor reach, links, moves and held folders', () => {
  test('S179 a host without descriptor reach refuses a remove as an owner root does, and a link or move never', async () => {
    const f = await fresh({
      disk: nodeFs(() => crypto.randomUUID(), { descriptorFolder: '/nonexistent-descriptor-folder' }),
    });
    await f.root.writeText(at(f.root, '.mcp.json'), 'x');
    await f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'x');
    expect(await refusalOf(() => f.root.remove(at(f.root, '.mcp.json')))).toBe('no_descriptor_reach');
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude/skills/x')))).toBe('no_descriptor_reach');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('x');
    expect(await exists(`${f.proj}/.claude/skills/x/a.md`)).toBe(true);
  });

  test('S179 a link or a move is never made inside a project folder; a held folder is refused', async () => {
    const f = await fresh();
    await f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'x');
    expect(
      await refusalOf(() =>
        f.root.linkTo(at(f.root, '.claude/skills/x/l'), { root: f.root, path: at(f.root, '.mcp.json') }),
      ),
    ).toBe('read_only');
    expect(await refusalOf(() => f.root.rename(at(f.root, '.claude/skills/x'), at(f.root, '.claude/skills/z')))).toBe(
      'read_only',
    );
    expect(await refusalOf(() => f.root.unlink(at(f.root, '.claude/skills/x/l')))).toBe('read_only');
    expect(await refusalOf(() => f.root.pin(at(f.root, '.claude/skills/x')))).toBe('not_declared');
    expect(await exists(`${f.proj}/.claude/skills/x/a.md`)).toBe(true);
  });

  test('S179 a folder copied into the set lands at a grant; a copy aimed above a grant is refused', async () => {
    const f = await fresh({});
    const roots = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: f.home, plugin: 'mcp', worktrees: `${f.home}-worktrees` },
      ['project-files', 'worktrees'],
      () => undefined,
      { projectFiles: DECLARED, random: () => 'rnd' },
    );
    await mkdir(`${f.home}-worktrees/src/pack`, { recursive: true });
    await writeFile(`${f.home}-worktrees/src/pack/SKILL.md`, '# pack');
    const source = roots.root('worktrees');
    const target = roots.root('project-files', { subfolder: f.proj });
    await target.copyTree(source, at(source, 'src/pack'), at(target, '.claude/skills/pack'));
    expect(await readFile(`${f.proj}/.claude/skills/pack/SKILL.md`, 'utf8')).toBe('# pack');
    expect(await refusalOf(() => target.copyTree(source, at(source, 'src/pack'), at(target, '.claude/skills')))).toBe(
      'not_declared',
    );
    expect(await refusalOf(() => target.copyTree(source, at(source, 'src/pack'), at(target, 'other')))).toBe(
      'not_declared',
    );
  });
});

describe('S179 copyTree is not a second door for a link (H1)', () => {
  /** The project folder and an internal root of the same plugin, with one folder to copy from the internal root. */
  async function withDownloads() {
    const f = await fresh();
    const roots = f.port(DECLARED, ['project-files', 'downloads']);
    const downloads = roots.root('downloads');
    const project = roots.root('project-files', { subfolder: f.proj });
    await mkdir(`${f.home}/state/mcp/downloads/pack`, { recursive: true });
    await writeFile(`${f.home}/state/mcp/downloads/pack/SKILL.md`, '# pack');
    return { f, downloads, project };
  }

  test('S179 copyTree {link:true} INTO a project folder is refused read_only: nothing is planted, so no write reaches the state home', async () => {
    const { f, downloads, project } = await withDownloads();
    await mkdir(`${f.proj}/.claude/skills`, { recursive: true });
    expect(
      await refusalOf(() =>
        project.copyTree(downloads, at(downloads, 'pack'), at(project, '.claude/skills/pack'), { link: true }),
      ),
    ).toBe('read_only');
    expect(await exists(`${f.proj}/.claude/skills/pack`)).toBe(false);
    // the set is judged first, as for a copy: a name above a grant is not_declared whatever the options
    expect(
      await refusalOf(() =>
        project.copyTree(downloads, at(downloads, 'pack'), at(project, '.claude/skills'), { link: true }),
      ),
    ).toBe('not_declared');
    // the one door left is a COPY, which makes real files in a new folder
    await project.copyTree(downloads, at(downloads, 'pack'), at(project, '.claude/skills/pack'));
    expect((await lstat(`${f.proj}/.claude/skills/pack`)).isSymbolicLink()).toBe(false);
    expect(await readFile(`${f.proj}/.claude/skills/pack/SKILL.md`, 'utf8')).toBe('# pack');
    expect(await readdir(`${f.home}/state/mcp/downloads/pack`)).toEqual(['SKILL.md']);
  });

  test('S179 copyTree {link:true} FROM a project folder into an internal root is refused: no link outlives the declared set', async () => {
    const { f, downloads, project } = await withDownloads();
    await project.writeText(at(project, '.claude/skills/x/SKILL.md'), '# x');
    // `downloads` takes no link (BG-004): the destination refuses first; the not_declared of a link FROM a project
    // folder into a root that DOES take links (fleet, agent-homes) is in root-copytree-link.test.ts
    expect(
      await refusalOf(() =>
        downloads.copyTree(project, at(project, '.claude/skills/x'), at(downloads, 'linked'), { link: true }),
      ),
    ).toBe('read_only');
    expect(await exists(`${f.home}/state/mcp/downloads/linked`)).toBe(false);
    // a COPY out of the set still works
    await downloads.copyTree(project, at(project, '.claude/skills/x'), at(downloads, 'copied'));
    expect(await readFile(`${f.home}/state/mcp/downloads/copied/SKILL.md`, 'utf8')).toBe('# x');
  });

  test('S179 a copy out of a project folder is gated by the folder own set: a name above a grant is refused', async () => {
    const { f, downloads, project } = await withDownloads();
    await project.writeText(at(project, '.claude/skills/x/SKILL.md'), '# x');
    await writeFile(`${f.proj}/.claude/settings.json`, 'private-ish');
    expect(await refusalOf(() => downloads.copyTree(project, at(project, '.claude'), at(downloads, 'got')))).toBe(
      'not_declared',
    );
    expect(
      await refusalOf(() => downloads.copyTree(project, at(project, '.claude/skills'), at(downloads, 'got'))),
    ).toBe('not_declared');
    expect(await exists(`${f.home}/state/mcp/downloads/got`)).toBe(false);
  });
});

describe('S179 a link swapped in after the judge (Md1) and the writes without descriptor reach (H2)', () => {
  /** A disk that runs `before` the `skip`+1th time `which` is called with a path `match` accepts, and `after` once it returns. */
  function hooked(
    base: HostFs,
    which: 'realpath' | 'writeNew' | 'rename',
    match: (path: string) => boolean,
    hooks: {
      readonly before: () => void;
      readonly after?: () => void;
      readonly skip?: number;
      readonly times?: number;
    },
  ): HostFs {
    let skip = hooks.skip ?? 0;
    let times = hooks.times ?? 1;
    const original = base[which] as (...args: never[]) => Promise<unknown>;
    const wrapped = async (...args: never[]): Promise<unknown> => {
      if (times > 0 && match(args[0] as unknown as string)) {
        if (skip > 0) skip -= 1;
        else {
          times -= 1;
          hooks.before();
          try {
            return await original.apply(base, args);
          } finally {
            hooks.after?.();
          }
        }
      }
      return await original.apply(base, args);
    };
    return { ...base, [which]: wrapped } as HostFs;
  }

  test('S179 an in-folder swap of a grant folder for a link to another place in the project is refused at EVERY walk, never followed', async () => {
    // the swap lands at the first, the second and the third look the write's walk takes at the folder
    for (const skip of [0, 1, 2]) {
      const where = { proj: '' };
      const x = (): string => `${where.proj}/.claude/skills/x`;
      const disk = hooked(
        nodeFs(() => crypto.randomUUID()),
        'realpath',
        path => path === x(),
        {
          skip,
          before: () => {
            renameSync(x(), `${x()}.aside`);
            symlinkSync(`${where.proj}/.claude/other`, x());
          },
        },
      );
      const f = await fresh({ disk });
      where.proj = f.proj;
      await mkdir(x(), { recursive: true });
      await mkdir(`${f.proj}/.claude/other`, { recursive: true });
      const refusal = await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'plugin'));
      // the first look refuses it as a link; a later look (the folder was already held) finds the folder is no longer the
      // one it proved: either way it is refused, never followed
      expect(['link_escape', 'changed']).toContain(refusal as string);
      if (skip === 0) expect(refusal).toBe('link_escape');
      // a name OUTSIDE the declared set never receives the write
      expect(await exists(`${f.proj}/.claude/other/a.md`)).toBe(false);
    }
  });

  test('S179 the same swap is refused for a read, a listing and a stat of the folder: a name outside the set is never reached', async () => {
    const where = { proj: '' };
    const x = (): string => `${where.proj}/.claude/skills/x`;
    const swap = (): void => {
      renameSync(x(), `${x()}.aside`);
      symlinkSync(`${where.proj}/.claude/other`, x());
    };
    const probes: readonly (readonly [string, (root: RootHandle) => Promise<unknown>])[] = [
      ['read', async root => await root.readText(at(root, '.claude/skills/x/a.md'))],
      ['list', async root => await root.list(at(root, '.claude/skills/x'))],
      ['stat', async root => await root.stat(at(root, '.claude/skills/x/a.md'))],
    ];
    for (const [label, call] of probes) {
      const disk = hooked(
        nodeFs(() => crypto.randomUUID()),
        'realpath',
        path => path === x() || path === `${x()}/a.md`,
        { before: swap },
      );
      const f = await fresh({ disk });
      where.proj = f.proj;
      await mkdir(x(), { recursive: true });
      await writeFile(`${x()}/a.md`, 'declared');
      await mkdir(`${f.proj}/.claude/other`, { recursive: true });
      await writeFile(`${f.proj}/.claude/other/a.md`, 'NOT in the set');
      expect([label, await refusalOf(() => call(f.root))]).toEqual([label, 'link_escape']);
    }
  });

  test('S179 a swap for a link OUT of the folder or into the state home is refused and nothing lands (still true)', async () => {
    for (const target of ['outside', 'home/config'] as const) {
      const where = { parent: '', proj: '' };
      const x = (): string => `${where.proj}/.claude/skills/x`;
      const disk = hooked(
        nodeFs(() => crypto.randomUUID()),
        'realpath',
        path => path === x(),
        {
          before: () => {
            renameSync(x(), `${x()}.aside`);
            symlinkSync(`${where.parent}/${target}`, x());
          },
        },
      );
      const f = await fresh({ disk });
      where.parent = f.parent;
      where.proj = f.proj;
      await mkdir(x(), { recursive: true });
      expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'plugin'))).toBe(
        'link_escape',
      );
      expect(await exists(`${f.parent}/${target}/a.md`)).toBe(false);
    }
  });

  /** The two-swap race: the folder is a link to the state home's `config` for the instant of the temp create and of the rename. */
  function twoSwap(disk: HostFs, where: { parent: string; proj: string }): HostFs {
    const x = (): string => `${where.proj}/.claude/skills/x`;
    const toLink = (): void => {
      renameSync(x(), `${x()}.aside`);
      symlinkSync(`${where.parent}/home/config`, x());
    };
    const back = (): void => {
      unlinkSync(x());
      renameSync(`${x()}.aside`, x());
    };
    const temp = (path: string): boolean => path.includes('.a.md.rnd.tmp');
    return hooked(hooked(disk, 'writeNew', temp, { before: toLink, after: back }), 'rename', temp, {
      before: toLink,
      after: back,
    });
  }

  test('S179 with descriptor reach the two-swap race cannot overwrite a same-named file inside the state home', async () => {
    const where = { parent: '', proj: '' };
    const f = await fresh({
      disk: twoSwap(
        nodeFs(() => crypto.randomUUID()),
        where,
      ),
    });
    where.parent = f.parent;
    where.proj = f.proj;
    await mkdir(`${f.proj}/.claude/skills/x`, { recursive: true });
    await writeFile(`${f.home}/config/a.md`, 'victim');
    await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'plugin'));
    expect(await readFile(`${f.home}/config/a.md`, 'utf8')).toBe('victim');
  });

  test('S179 GAP (BEFORE-GREEN, ports-pending writeChecked): without descriptor reach a write is by path, so the two-swap race still lands; this flips when the macOS FFI unit closes it', async () => {
    const where = { parent: '', proj: '' };
    const noReach = nodeFs(() => crypto.randomUUID(), { descriptorFolder: '/nonexistent-descriptor-folder' });
    const f = await fresh({ disk: twoSwap(noReach, where) });
    where.parent = f.parent;
    where.proj = f.proj;
    await mkdir(`${f.proj}/.claude/skills/x`, { recursive: true });
    await writeFile(`${f.home}/config/a.md`, 'victim');
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'plugin'))).toBeUndefined();
    // the declared residual, stated exactly: a same-named file is overwritten. Nothing else is reached (the name and the
    // content are the plugin's own), and the registered unit closes it for `work`, MCP and Skills at once.
    expect(await readFile(`${f.home}/config/a.md`, 'utf8')).toBe('plugin');
  });

  test('S179 a write without descriptor reach is NOT refused: MCP and Skills keep writing on a host that has none', async () => {
    const f = await fresh({
      disk: nodeFs(() => crypto.randomUUID(), { descriptorFolder: '/nonexistent-descriptor-folder' }),
    });
    await f.root.writeText(at(f.root, '.mcp.json'), 'x');
    await f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'y');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('x');
    expect(await readFile(`${f.proj}/.claude/skills/x/a.md`, 'utf8')).toBe('y');
  });
});

describe('S179 review minors: links to a same-named place, remove of a link, folders above a grant', () => {
  test('S179 a skill folder that is a link to a SAME-NAMED place inside the folder is refused, not followed', async () => {
    const f = await fresh();
    await mkdir(`${f.proj}/.claude/skills/other/x`, { recursive: true });
    await symlink(`${f.proj}/.claude/skills/other/x`, `${f.proj}/.claude/skills/x`);
    expect(await refusalOf(() => f.root.writeText(at(f.root, '.claude/skills/x/a.md'), 'no'))).toBe('link_escape');
    expect(await refusalOf(() => f.root.readText(at(f.root, '.claude/skills/x/a.md')))).toBe('link_escape');
    expect(await readdir(`${f.proj}/.claude/skills/other/x`)).toEqual([]);
  });

  test('S179 remove of a link at a grant unlinks the link and never the tree it points at', async () => {
    const f = await fresh();
    await writeFile(`${f.outside}/precious.md`, 'precious');
    await mkdir(`${f.proj}/.claude/skills`, { recursive: true });
    await symlink(f.outside, `${f.proj}/.claude/skills/x`);
    await f.root.remove(at(f.root, '.claude/skills/x'));
    expect(await exists(`${f.proj}/.claude/skills/x`)).toBe(false);
    expect(await readFile(`${f.outside}/precious.md`, 'utf8')).toBe('precious');
    // and a link on the way to the name stays refused
    await symlink(f.outside, `${f.proj}/.agents`);
    expect(await refusalOf(() => f.root.remove(at(f.root, '.agents/skills/x')))).toBe('link_escape');
    expect(await readFile(`${f.outside}/precious.md`, 'utf8')).toBe('precious');
  });

  test('S179 ensurePrivateDirectory above a grant makes a folder (0700) and never changes the mode of one that exists', async () => {
    const f = await fresh();
    await mkdir(`${f.proj}/.claude`, { mode: 0o775 });
    await chmod(`${f.proj}/.claude`, 0o775);
    await f.root.ensurePrivateDirectory(at(f.root, '.claude'));
    expect((await stat(`${f.proj}/.claude`)).mode & 0o777).toBe(0o775);
    await f.root.ensurePrivateDirectory(at(f.root, '.claude/skills/fresh'));
    expect((await stat(`${f.proj}/.claude/skills/fresh`)).mode & 0o777).toBe(0o700);
    expect((await stat(`${f.proj}/.claude`)).mode & 0o777).toBe(0o775);
  });

  test('BG-014 m2 ensurePrivateDirectory outside the declared set is refused not_declared and makes nothing (O7)', async () => {
    const f = await fresh();
    for (const outside of ['.git/hooks-x', 'other', '.claude/other', '.claude/settings.d', 'sub/.claude/skills/x/y']) {
      expect(await refusalOf(() => f.root.ensurePrivateDirectory(at(f.root, outside)))).toBe('not_declared');
    }
    expect(await readdir(f.proj)).toEqual([]);
  });
});

describe('BG-014 m1 linkTo a project file from a link root is refused not_declared on the real host (O1)', () => {
  test('BG-014 m1 a link root cannot point at a project file, dangling or not, and nothing is made', async () => {
    const f = await fresh();
    const roots = f.port(DECLARED, ['project-files', 'agent-homes']);
    const agent = roots.root('agent-homes');
    const project = roots.root('project-files', { subfolder: f.proj });
    await project.writeText(at(project, '.mcp.json'), '{"mcpServers":{}}\n');
    expect(await refusalOf(() => agent.linkTo(at(agent, 'l'), { root: project, path: at(project, '.mcp.json') }))).toBe(
      'not_declared',
    );
    expect(
      await refusalOf(() =>
        agent.linkTo(at(agent, 'l2'), { root: project, path: at(project, '.mcp.json'), dangling: true }),
      ),
    ).toBe('not_declared');
    expect(
      await refusalOf(() =>
        agent.linkTo(at(agent, 'l3'), { root: project, path: at(project, '.claude/skills/x/a.md') }),
      ),
    ).toBe('not_declared');
    expect(await readFile(`${f.proj}/.mcp.json`, 'utf8')).toBe('{"mcpServers":{}}\n');
  });
});
