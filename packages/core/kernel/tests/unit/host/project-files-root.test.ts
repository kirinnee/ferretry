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
    expect(await refusalOf(() => f.root.remove(at(f.root, '.claude/skills/x')))).toBe('link_escape');
    expect(await readdir(`${f.proj}/src`)).toEqual([]);
    // a link in the middle of a deeper name
    await rm(`${f.proj}/.claude/skills/x`);
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
