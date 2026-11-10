/**
 * The skill file router and the two readers it sends a path to (a registered project's skills folders, Skills' own
 * installed store). Fakes only: a path is claimed by what it IS, and a path nothing claims is nothing.
 */
import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { RuntimeAssetSkills, RuntimeHome, RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';
import { InstalledSkillFiles } from '../../daemon/adapters/installed-store.ts';
import { ProjectSkillFiles } from '../../daemon/adapters/project-skill-files.ts';
import { SkillFilesRouter } from '../../daemon/adapters/skill-files-router.ts';
import type { SkillFilesPort } from '../../daemon/lib/inventory.ts';

const HOME: RuntimeHome = {
  id: 'a',
  harness: 'claude-code',
  runtimes: ['claude-a' as never],
  home: '/fy/fleet/homes/a',
  wrapper: '/fy/fleet/bin/claude-a',
};
const ASSETS = '/fy/fleet/assets/skills';

const reader = (over: Partial<RuntimeHomeReader> = {}): RuntimeHomeReader => ({
  document: async () => null,
  skills: async () => [
    { name: 'mine', manifest: `${HOME.home}/skills/mine/SKILL.md`, managed: false },
    { name: 'ours', manifest: `${HOME.home}/skills/ours/SKILL.md`, managed: true },
  ],
  skillManifest: async name => `home text of ${name}`,
  skillTree: async () => undefined,
  skillFile: async () => ({ ok: false, reason: 'unreadable' }),
  ...over,
});

const assets = (over: Partial<RuntimeAssetSkills> = {}): RuntimeAssetSkills => ({
  skills: async () => [{ name: 'tool', manifest: `${ASSETS}/tool/SKILL.md`, managed: true }],
  skillManifest: async name => `asset text of ${name}`,
  ...over,
});

const state = (files: Record<string, string | Uint8Array | 'dir'>, fail = false) => ({
  pathOf: (_file: unknown, name?: string) => `/state/skills/installed/${name ?? ''}`,
  stat: async (_file: unknown, name: string) => {
    if (fail) throw new Error('boom');
    const found = files[name];
    return found === undefined ? undefined : { kind: found === 'dir' ? 'directory' : 'file', modifiedMs: 0 };
  },
  read: async (_file: unknown, name: string) => {
    if (fail) throw new Error('boom');
    const found = files[name];
    return ok(found === undefined || found === 'dir' ? undefined : found);
  },
});

const listed = (...manifests: string[]): SkillFilesPort => ({
  list: async directory => manifests.filter(m => m.startsWith(`${directory}/`)).map(manifest => ({ manifest })),
  read: async path => (manifests.includes(path) ? `text of ${path}` : undefined),
});

/** A scoped project handle over a map of absolute path -> text; `real` is what `realPath` answers for the base. */
function handleOver(base: string, files: Record<string, string>, real: string = base): RootHandle {
  const kids = (path: string): string[] => [
    ...new Set(
      Object.keys(files)
        .filter(file => file.startsWith(`${path}/`))
        .map(file => file.slice(path.length + 1).split('/')[0]!),
    ),
  ];
  const stat = async (path: string) =>
    path in files
      ? {
          kind: 'file' as const,
          size: files[path]!.length,
          modified: '2026-01-01T00:00:00Z' as never,
          mode: 0o600,
          links: 1,
        }
      : kids(path).length > 0
        ? { kind: 'directory' as const, size: 0, modified: '2026-01-01T00:00:00Z' as never, mode: 0o700, links: 1 }
        : undefined;
  const handle = {
    name: 'imports',
    internal: false,
    resolve: (given: string) =>
      given.includes('..') ? err('outside') : ok((given === '' ? base : `${base}/${given}`) as FencedPath),
    realPath: async () => real,
    list: async (path: string) => kids(path),
    stat,
    readText: async (path: string) => files[path] ?? '',
  };
  return handle as unknown as RootHandle;
}

describe('the skill file router', () => {
  const routing = (over: Record<string, unknown> = {}) => ({
    homes: async () => [HOME],
    home: (id: string) => (id === 'a' ? reader() : undefined),
    assets: () => assets(),
    installed: new InstalledSkillFiles(state({ 'inst/SKILL.md': 'installed text' }) as never),
    projects: new ProjectSkillFiles(
      async () => ['/work/p'],
      () => handleOver('/work/p/.claude/skills', { '/work/p/.claude/skills/pp/SKILL.md': 'project text' }),
    ),
    ...over,
  });

  test('R-0197 an account home’s folder is listed through Runtimes’ reader, with its managed flag', async () => {
    const found = await new SkillFilesRouter(routing()).list(`${HOME.home}/skills`, 10);
    expect(found).toEqual([
      { manifest: `${HOME.home}/skills/mine/SKILL.md`, managed: false },
      { manifest: `${HOME.home}/skills/ours/SKILL.md`, managed: true },
    ]);
  });

  test('a home that is no longer published, or whose reader fails, lists nothing', async () => {
    expect(await new SkillFilesRouter(routing({ home: () => undefined })).list(`${HOME.home}/skills`, 10)).toEqual([]);
    const failing = routing({ home: () => reader({ skills: async () => Promise.reject(new Error('x')) }) });
    expect(await new SkillFilesRouter(failing).list(`${HOME.home}/skills`, 10)).toEqual([]);
  });

  test('R-0197 a registered project’s skills folder is listed, and a folder of no registered root is not', async () => {
    const router = new SkillFilesRouter(routing());
    expect((await router.list('/work/p/.claude/skills', 10)).map(entry => entry.manifest)).toEqual([
      '/work/p/.claude/skills/pp/SKILL.md',
    ]);
    expect(await router.list('/work/other/.claude/skills', 10)).toEqual([]);
    expect(await router.list('/etc', 10)).toEqual([]);
  });

  test('R-0197 a ferret working in a folder that holds the Ferretry home still sees its home, asset and installed skills', async () => {
    // The kernel allows a work folder that CONTAINS the home; its `work` root answers those paths fenced (nothing).
    const fenced: SkillFilesPort = { list: async () => [], read: async () => undefined };
    const router = new SkillFilesRouter(routing({ work: { files: fenced, base: '/' } }));
    expect((await router.list(`${HOME.home}/skills`, 10)).map(entry => entry.manifest)).toEqual([
      `${HOME.home}/skills/mine/SKILL.md`,
      `${HOME.home}/skills/ours/SKILL.md`,
    ]);
    expect(await router.read(`${HOME.home}/skills/mine/SKILL.md`, 100)).toBe('home text of mine');
    expect(await router.read(`${ASSETS}/tool/SKILL.md`, 100)).toBe('asset text of tool');
    expect(await router.read('/state/skills/installed/inst/SKILL.md', 100)).toBe('installed text');
    // every other path of that folder still goes to the work root
    expect(await router.list('/work/p/.claude/skills', 10)).toEqual([]);
    expect(await router.read('/work/p/.claude/skills/pp/SKILL.md', 100)).toBeUndefined();
  });

  test('a ferret’s own folder is read through its work files, before a registered project’s folder', async () => {
    const work = { files: listed('/work/f/.claude/skills/w/SKILL.md'), base: '/work/f' };
    const router = new SkillFilesRouter(routing({ work }));
    expect((await router.list('/work/f/.claude/skills', 10)).map(entry => entry.manifest)).toEqual([
      '/work/f/.claude/skills/w/SKILL.md',
    ]);
    expect(await router.read('/work/f/.claude/skills/w/SKILL.md', 100)).toBe(
      'text of /work/f/.claude/skills/w/SKILL.md',
    );
  });

  test('a home’s manifest is read through the reader, and only for a published home', async () => {
    const router = new SkillFilesRouter(routing());
    expect(await router.read(`${HOME.home}/skills/mine/SKILL.md`, 100)).toBe('home text of mine');
    expect(await router.read('/fy/fleet/homes/zzz/skills/mine/SKILL.md', 100)).toBeUndefined();
    const failing = routing({ home: () => reader({ skillManifest: () => Promise.reject(new Error('x')) }) });
    expect(await new SkillFilesRouter(failing).read(`${HOME.home}/skills/mine/SKILL.md`, 100)).toBeUndefined();
    const gone = routing({ home: () => undefined });
    expect(await new SkillFilesRouter(gone).read(`${HOME.home}/skills/mine/SKILL.md`, 100)).toBeUndefined();
  });

  test('U11 a fleet asset’s manifest is read only when the asset listing names that exact path', async () => {
    const router = new SkillFilesRouter(routing());
    expect(await router.read(`${ASSETS}/tool/SKILL.md`, 100)).toBe('asset text of tool');
    // a planted folder the tree does not list is nothing
    expect(await router.read(`${ASSETS}/planted/SKILL.md`, 100)).toBeUndefined();
    expect(await router.read(`${ASSETS}/tool/../tool/SKILL.md`, 100)).toBeUndefined();
    expect(
      await new SkillFilesRouter(routing({ assets: () => undefined })).read(`${ASSETS}/tool/SKILL.md`, 100),
    ).toBeUndefined();
    const failing = routing({ assets: () => assets({ skills: () => Promise.reject(new Error('x')) }) });
    expect(await new SkillFilesRouter(failing).read(`${ASSETS}/tool/SKILL.md`, 100)).toBeUndefined();
    const unread = routing({ assets: () => assets({ skillManifest: () => Promise.reject(new Error('x')) }) });
    expect(await new SkillFilesRouter(unread).read(`${ASSETS}/tool/SKILL.md`, 100)).toBeUndefined();
  });

  test('an installed skill’s manifest is read from the store, and a project’s through the project reader', async () => {
    const router = new SkillFilesRouter(routing());
    expect(await router.read('/state/skills/installed/inst/SKILL.md', 100)).toBe('installed text');
    expect(await router.read('/work/p/.claude/skills/pp/SKILL.md', 100)).toBe('project text');
    expect(await router.read('/etc/passwd', 100)).toBeUndefined();
  });
});

describe('Skills’ installed store reader', () => {
  const files = {
    'inst/SKILL.md': 'text',
    'bytes/SKILL.md': new TextEncoder().encode('from bytes'),
    'dir/SKILL.md': 'dir' as const,
  };

  test('lists the folders the store holds with a regular SKILL.md, as Ferretry’s', async () => {
    const store = new InstalledSkillFiles(state(files as never) as never);
    expect(await store.entries(['inst', 'dir', 'absent', '../x', '.hidden'])).toEqual([
      { manifest: '/state/skills/installed/inst/SKILL.md', managed: true },
    ]);
    expect(await new InstalledSkillFiles(state(files as never, true) as never).entries(['inst'])).toEqual([]);
  });

  test('claims exactly the path the store gives for a usable folder’s SKILL.md', () => {
    const store = new InstalledSkillFiles(state({}) as never);
    expect(store.claims('/state/skills/installed/inst/SKILL.md')).toBe(true);
    expect(store.claims('/state/skills/installed/inst/other.md')).toBe(false);
    expect(store.claims('/state/skills/installed/../x/SKILL.md')).toBe(false);
    expect(store.claims('/elsewhere/inst/SKILL.md')).toBe(false);
  });

  test('reads text, decodes bytes, and refuses over the bound, a folder, an absence and a fault', async () => {
    const store = new InstalledSkillFiles(state(files as never) as never);
    expect(await store.read('/state/skills/installed/inst/SKILL.md', 100)).toBe('text');
    expect(await store.read('/state/skills/installed/bytes/SKILL.md', 100)).toBe('from bytes');
    expect(await store.read('/state/skills/installed/inst/SKILL.md', 3)).toBeUndefined();
    expect(await store.read('/state/skills/installed/dir/SKILL.md', 100)).toBeUndefined();
    expect(await store.read('/state/skills/installed/absent/SKILL.md', 100)).toBeUndefined();
    expect(await store.read('/elsewhere/inst/SKILL.md', 100)).toBeUndefined();
    expect(
      await new InstalledSkillFiles(state(files as never, true) as never).read(
        '/state/skills/installed/inst/SKILL.md',
        100,
      ),
    ).toBeUndefined();
    const damaged = { ...state(files as never), read: async () => err({ kind: 'damaged' }) };
    expect(
      await new InstalledSkillFiles(damaged as never).read('/state/skills/installed/inst/SKILL.md', 100),
    ).toBeUndefined();
    const thrown = { ...state(files as never), read: async () => Promise.reject(new Error('x')) };
    expect(
      await new InstalledSkillFiles(thrown as never).read('/state/skills/installed/inst/SKILL.md', 100),
    ).toBeUndefined();
  });
});

describe('a registered project’s skills reader', () => {
  const open = (real?: string) => (folder: string) =>
    handleOver(folder, { [`${folder}/pp/SKILL.md`]: 'project text', [`${folder}/pp/notes.md`]: 'secret' }, real);
  const project = (over: { roots?: string[]; real?: string; open?: (folder: string) => RootHandle } = {}) =>
    new ProjectSkillFiles(async () => over.roots ?? ['/work/p/'], over.open ?? open(over.real));

  test('R-0198 lists and reads only the SKILL.md of a skill folder under a registered root’s skills folder', async () => {
    const files = project();
    expect(await files.claims('/work/p/.claude/skills')).toBe(true);
    expect(await files.claims('/work/p/.agents/skills')).toBe(true);
    expect((await files.list('/work/p/.agents/skills', 10)).map(entry => entry.manifest)).toEqual([
      '/work/p/.agents/skills/pp/SKILL.md',
    ]);
    expect(await files.read('/work/p/.claude/skills/pp/SKILL.md', 100)).toBe('project text');
  });

  test('R-0198 a file that is not a SKILL.md, another folder of the project or an unregistered root answers nothing', async () => {
    const files = project();
    expect(await files.read('/work/p/.claude/skills/pp/notes.md', 100)).toBeUndefined();
    expect(await files.read('/work/p/src/pp/SKILL.md', 100)).toBeUndefined();
    expect(await files.read('/work/q/.claude/skills/pp/SKILL.md', 100)).toBeUndefined();
    expect(await files.list('/work/p/.codex/skills', 10)).toEqual([]);
    expect(await files.list('/work/q/.claude/skills', 10)).toEqual([]);
    expect(await files.claims('/work/p/.claude/skills/pp')).toBe(false);
  });

  test('a skills folder that is a link, or under one, answers nothing', async () => {
    const linked = project({ real: '/elsewhere/skills' });
    expect(await linked.list('/work/p/.claude/skills', 10)).toEqual([]);
    expect(await linked.read('/work/p/.claude/skills/pp/SKILL.md', 100)).toBeUndefined();
  });

  test('a folder the kernel refuses to open, or cannot name, answers nothing', async () => {
    const refusing = project({
      open: () => {
        throw new Error('not declared');
      },
    });
    expect(await refusing.list('/work/p/.claude/skills', 10)).toEqual([]);
    const unnamed = project({ open: () => ({ resolve: () => err('outside') }) as unknown as RootHandle });
    expect(await unnamed.list('/work/p/.claude/skills', 10)).toEqual([]);
  });
});
