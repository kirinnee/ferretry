/**
 * The edges of the three skill adapters a catalog walks: a project skill folder that holds more than a skill can, a file
 * that is no plain file, a text that is not text, a handle that fails half-way through a walk. The project folders run
 * over the kernel's REAL `project-files` root on a temp disk (never a real home); the tree walk, whose failures a real
 * disk will not make on demand, runs over a root handle of this test's own that fails at the exact step named.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { SkillFolderChanged, SkillFolderRefused } from '@ferretry/plugin-catalogs/contract';
import { err, ok } from '@ferretry/std';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { CatalogSkillTree } from '../../daemon/adapters/catalog-skill-tree.ts';
import { InstalledSkillAssets } from '../../daemon/adapters/installed-assets.ts';
import { ProjectSkillFolders } from '../../daemon/adapters/project-skill-folders.ts';
import { SKILL_FILE_MAX_BYTES } from '../../daemon/adapters/skill-bounds.ts';
import manifest from '../../manifest.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const refusal = async (run: () => Promise<unknown>): Promise<Error> => {
  const caught = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(SkillFolderRefused);
  return caught as Error;
};

async function projectWorld() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-skill-limits-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.claude', 'skills', 'pdf'), { recursive: true });
  await writeFile(join(project, '.claude', 'skills', 'pdf', 'SKILL.md'), 'doc');
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'skills', worktrees: `${home}-w` },
    ['project-files'],
    () => undefined,
    { projectFiles: manifest.permissions?.projectFiles ?? [], stateFiles: [], shareTrees: true, onStop: () => {} },
  );
  const folders = new ProjectSkillFolders(
    async () => [project],
    root => roots.root('project-files', { subfolder: root, within: root }),
  );
  return { parent, project, folder: '.claude/skills/pdf', disk: join(project, '.claude', 'skills', 'pdf'), folders };
}

describe('a project skill folder that is more than a skill, or not plain, is refused and left alone', () => {
  test('a file over the per-file bound is named as one that cannot be shown, not read', async () => {
    const w = await projectWorld();
    await writeFile(join(w.disk, 'big.txt'), 'x'.repeat(SKILL_FILE_MAX_BYTES + 1));
    const reading = await w.folders.read(w.project, w.folder, ['SKILL.md', 'big.txt']);
    expect(reading.tooLarge).toEqual(['big.txt']);
    expect([...reading.files.keys()]).toEqual(['SKILL.md']);
  });

  test('a folder whose files add up to more than a skill holds is refused when it is looked at', async () => {
    const w = await projectWorld();
    const half = 'x'.repeat(2.5 * 1024 * 1024);
    await writeFile(join(w.disk, 'one.bin'), half);
    await writeFile(join(w.disk, 'two.bin'), half);
    const refused = await refusal(() => w.folders.inspect(w.project, w.folder));
    expect(refused.message).toBe('.claude/skills/pdf holds more than a skill can, so Ferretry left it alone.');
  });

  test('a link inside the folder is refused with the sentence for a file that is not plain, by inspect and by read', async () => {
    const w = await projectWorld();
    await symlink(join(w.project, 'outside.txt'), join(w.disk, 'link'));
    const sentence = 'link is not a plain file (a link or a special file), so Ferretry will not read it.';
    expect((await refusal(() => w.folders.inspect(w.project, w.folder))).message).toBe(sentence);
    expect((await refusal(() => w.folders.read(w.project, w.folder, ['link']))).message).toBe(sentence);
  });

  test('a skill folder that is a file is not a folder a skill can go in', async () => {
    const w = await projectWorld();
    await rm(w.disk, { recursive: true });
    await writeFile(w.disk, 'not a folder');
    const refused = await refusal(() => w.folders.inspect(w.project, w.folder));
    expect(refused.message).toBe('.claude/skills/pdf is not a folder, so a skill cannot go there.');
  });

  test('a write over a folder that sits where a file should go is refused, and names the path', async () => {
    const w = await projectWorld();
    await mkdir(join(w.disk, 'notes'));
    const refused = await refusal(() =>
      w.folders.apply(w.project, w.folder, {
        expected: new Map(),
        write: [{ path: 'notes', content: 'x' }],
        remove: [],
      } as never),
    );
    expect(refused.message).toBe('notes is not a plain file, so Ferretry will not replace it.');
  });

  test('a kernel refusal of any shape is the person’s sentence, never a stack; a refusal of ours passes through as it is', async () => {
    const sentence = (detail: string) =>
      `a path of the skill folder is a link, or not a plain file or folder, so Ferretry left it alone (${detail}).`;
    const over = (thrown: unknown) =>
      new ProjectSkillFolders(
        async () => ['/repo'],
        () =>
          ({
            resolve: (given: string) => ok(given),
            lstat: async () => {
              throw thrown;
            },
          }) as unknown as RootHandle,
      );
    const folder = '.claude/skills/pdf';
    expect((await refusal(() => over(new Error('link at .claude')).inspect('/repo', folder))).message).toBe(
      sentence('link at .claude'),
    );
    expect((await refusal(() => over('a bare string').inspect('/repo', folder))).message).toBe(sentence('refused'));
    const ours = new SkillFolderRefused('ours');
    expect(await refusal(() => over(ours).inspect('/repo', folder))).toBe(ours);
    const moved = new SkillFolderChanged();
    await expect(over(moved).inspect('/repo', folder)).rejects.toBe(moved);
  });
});

describe('what a catalog reads of an installed skill that is not text', () => {
  const store = (files: Record<string, Uint8Array>) => ({
    holds: async () => true,
    walk: async () => Object.keys(files).map(path => ({ path, kind: 'file' as const })),
    read: async (_name: string, path: string) => files[path],
    removePaths: async () => undefined,
  });

  test('a file over the bound and a file that is not UTF-8 are named as ones that cannot be shown; the rest is read', async () => {
    const assets = new InstalledSkillAssets(
      store({
        'SKILL.md': new TextEncoder().encode('doc'),
        'big.bin': new Uint8Array(SKILL_FILE_MAX_BYTES + 1),
        'raw.bin': new Uint8Array([0xff, 0xfe, 0xfd]),
      }),
    );
    const reading = await assets.read('review', ['SKILL.md', 'big.bin', 'raw.bin', 'missing']);
    expect([...reading.files]).toEqual([['SKILL.md', 'doc']]);
    expect(reading.tooLarge).toEqual(['big.bin', 'raw.bin']);
  });
});

/** A root handle that answers from a table of folders and fails where told: only what the tree walk calls is real. */
function handleOver(options: {
  readonly folders: Readonly<
    Record<string, readonly { name: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size?: number }[]>
  >;
  readonly failResolve?: readonly string[];
  readonly failEntries?: readonly string[];
  readonly lstat?: unknown;
  readonly failRead?: boolean;
}): RootHandle {
  return {
    resolve: (given: string) => (options.failResolve?.includes(given) === true ? err('link_escape') : ok(given)),
    entries: async (path: FencedPath) => {
      if (options.failEntries?.includes(path) === true) throw new Error('unreadable');
      return (options.folders[path] ?? []).map(entry => ({ size: 1, links: 1, ...entry }));
    },
    lstat: async () => options.lstat,
    readBytes: async () => {
      if (options.failRead === true) throw new Error('gone mid-read');
      return new Uint8Array([1]);
    },
  } as unknown as RootHandle;
}

const MANIFEST = '/repo/.claude/skills/pdf/SKILL.md';
const treeOver = (handle: () => RootHandle) =>
  new CatalogSkillTree({
    homes: async () => [],
    home: () => undefined,
    roots: async () => ['/repo'],
    open: handle,
  });
const LIMITS = { entries: 100, depth: 16 };

describe('a project skill walked through a handle that fails half-way', () => {
  test('a root that cannot be opened reads as a folder that is gone, for a listing and for a file', async () => {
    const tree = treeOver(() => {
      throw new Error('no such root');
    });
    expect(await tree.list(MANIFEST, LIMITS)).toBeUndefined();
    expect(await tree.read(MANIFEST, 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('a file that fails while it is read is unreadable, not an error', async () => {
    const tree = treeOver(() =>
      handleOver({ folders: {}, lstat: { kind: 'file', size: 1, links: 1 }, failRead: true }),
    );
    expect(await tree.read(MANIFEST, 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('a skill folder that cannot be listed is a folder that is gone', async () => {
    const tree = treeOver(() => handleOver({ folders: {}, failEntries: ['pdf'] }));
    expect(await tree.list(MANIFEST, LIMITS)).toBeUndefined();
  });

  test('a subfolder that cannot be listed is one entry of an unknown kind, and the walk goes on', async () => {
    const tree = treeOver(() =>
      handleOver({
        folders: {
          pdf: [
            { name: 'locked', kind: 'directory' },
            { name: 'SKILL.md', kind: 'file', size: 3 },
          ],
        },
        failEntries: ['pdf/locked'],
      }),
    );
    expect(await tree.list(MANIFEST, LIMITS)).toEqual({
      entries: [
        { path: 'SKILL.md', type: 'file', size: 3 },
        { path: 'locked', type: 'other', size: 0 },
      ],
      truncated: false,
    });
  });

  test('a subfolder the root refuses to resolve ends the walk with that folder as one entry of an unknown kind', async () => {
    const tree = treeOver(() =>
      handleOver({
        folders: {
          pdf: [
            { name: 'SKILL.md', kind: 'file', size: 3 },
            { name: 'escape', kind: 'directory' },
          ],
        },
        failResolve: ['pdf/escape'],
      }),
    );
    expect(await tree.list(MANIFEST, LIMITS)).toEqual({
      entries: [
        { path: 'SKILL.md', type: 'file', size: 3 },
        { path: 'escape', type: 'other', size: 0 },
      ],
      truncated: false,
    });
  });

  test('a skill folder the root refuses to resolve is a folder that is gone', async () => {
    const tree = treeOver(() => handleOver({ folders: {}, failResolve: ['pdf'] }));
    expect(await tree.list(MANIFEST, LIMITS)).toBeUndefined();
  });

  test('a tree longer than the walk allows stops at the limit and says it was cut short', async () => {
    const tree = treeOver(() =>
      handleOver({
        folders: {
          pdf: [
            { name: 'a', kind: 'file' },
            { name: 'b', kind: 'file' },
            { name: 'c', kind: 'file' },
          ],
        },
      }),
    );
    expect(await tree.list(MANIFEST, { entries: 2, depth: 16 })).toEqual({
      entries: [
        { path: 'a', type: 'file', size: 1 },
        { path: 'b', type: 'file', size: 1 },
      ],
      truncated: true,
    });
  });

  test('a device or a pipe in the folder is listed as an entry of an unknown kind, never read', async () => {
    const tree = treeOver(() => handleOver({ folders: { pdf: [{ name: 'pipe', kind: 'other' }] } }));
    expect(await tree.list(MANIFEST, LIMITS)).toEqual({
      entries: [{ path: 'pipe', type: 'other', size: 0 }],
      truncated: false,
    });
  });
});
