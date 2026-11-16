/**
 * What Catalogs asks of the skill kind (`catalog.items:skill`), over REAL parts on a temp disk (never a real home): the
 * kernel's real state port for the installed store, the real `imports` root for walking a project's skill and the real
 * `project-files` root for writing one (Skills' declared `.claude/skills/*` and `.agents/skills/*`). Runtimes and the
 * config writer are stood in by recording fakes; the whole path through the composed daemon is proved in the CLI's
 * `catalog-items` integration test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { CatalogItemRefusal, SkillFolderChanged, SkillFolderRefused } from '@ferretry/plugin-catalogs/contract';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { SKILLS_INSTALLED_STATE, type SkillsItem } from '../../contract/index.ts';
import { CatalogSkillTree } from '../../daemon/adapters/catalog-skill-tree.ts';
import { InstalledSkillAssets } from '../../daemon/adapters/installed-assets.ts';
import { ProjectSkillFolders } from '../../daemon/adapters/project-skill-folders.ts';
import { sha256Hex } from '../../daemon/adapters/sha256.ts';
import { skillsCatalogRuntime } from '../../daemon/lib/catalog-runtime.ts';
import { InstalledSkillConflict, SkillStore } from '../../daemon/lib/skill-store.ts';
import manifest from '../../manifest.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SKILL_DOC = '---\nname: pdf\ndescription: does pdf\n---\nbody\n';
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-catalog-skills-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(join(home, 'state', 'skills'), { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.claude', 'skills', 'pdf', 'scripts'), { recursive: true });
  await writeFile(join(project, '.claude', 'skills', 'pdf', 'SKILL.md'), SKILL_DOC);
  await writeFile(join(project, '.claude', 'skills', 'pdf', 'scripts', 'run.sh'), 'run\n');
  const fs = nodeFs(() => crypto.randomUUID());
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'skills', worktrees: `${home}-w` },
    ['imports', 'project-files'],
    () => undefined,
    {
      projectFiles: manifest.permissions?.projectFiles ?? [],
      stateFiles: manifest.data?.state ?? [],
      shareTrees: true,
      onStop: () => {},
    },
  );
  const port = state.createStatePort({
    home,
    pluginId: 'skills',
    files: [SKILLS_INSTALLED_STATE],
    fs: state.createNodeHostFs(),
  });
  const store = new SkillStore(port, { share: async source => await roots.share(source) });
  const known = [project];
  const folders = new ProjectSkillFolders(
    async () => known,
    root => roots.root('project-files', { subfolder: root, within: root }),
  );
  const tree = new CatalogSkillTree({
    homes: async () => [],
    home: () => undefined,
    roots: async () => known,
    open: (folder, within) => roots.root('imports', { subfolder: folder, within }),
  });
  return { parent, home, project, store, folders, tree, installed: join(home, 'state', 'skills', 'installed') };
}

const LIMITS = { entries: 1_000, depth: 16 };

describe('the walk of a project skill a catalog shares', () => {
  test('lists every file of the folder and reads one, as v4 NodeSkillFolder did', async () => {
    const w = await world();
    const manifestPath = join(w.project, '.claude', 'skills', 'pdf', 'SKILL.md');
    const listing = await w.tree.list(manifestPath, LIMITS);
    expect(listing?.entries.map(entry => `${entry.type}:${entry.path}`)).toEqual([
      'file:SKILL.md',
      'file:scripts/run.sh',
    ]);
    const read = await w.tree.read(manifestPath, 'scripts/run.sh', 1024);
    expect(read.ok && new TextDecoder().decode(read.bytes)).toBe('run\n');
    expect(await w.tree.read(manifestPath, 'scripts/run.sh', 2)).toEqual({ ok: false, reason: 'too_big' });
    expect(await w.tree.read(manifestPath, '../escape', 1024)).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('lists a link and a hard link and reads neither, so a skill cannot make a publisher read outside its folder', async () => {
    const w = await world();
    const folder = join(w.project, '.claude', 'skills', 'pdf');
    await writeFile(join(w.parent, 'secret.txt'), 'outside');
    await symlink(join(w.parent, 'secret.txt'), join(folder, 'linked.txt'));
    await link(join(w.parent, 'secret.txt'), join(folder, 'hard.txt'));
    const manifestPath = join(folder, 'SKILL.md');
    const types = Object.fromEntries(
      (await w.tree.list(manifestPath, LIMITS))?.entries.map(entry => [entry.path, entry.type]) ?? [],
    );
    expect(types['linked.txt']).toBe('symlink');
    expect(types['hard.txt']).toBe('hardlink');
    expect(await w.tree.read(manifestPath, 'linked.txt', 1024)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await w.tree.read(manifestPath, 'hard.txt', 1024)).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('a folder of an unregistered root, or one confined to another root, is a folder that is gone', async () => {
    const w = await world();
    const stranger = join(w.parent, 'stranger');
    await mkdir(join(stranger, '.claude', 'skills', 'x'), { recursive: true });
    await writeFile(join(stranger, '.claude', 'skills', 'x', 'SKILL.md'), SKILL_DOC);
    expect(await w.tree.list(join(stranger, '.claude', 'skills', 'x', 'SKILL.md'), LIMITS)).toBeUndefined();
    expect(
      await w.tree.list(join(w.project, '.claude', 'skills', 'pdf', 'SKILL.md'), LIMITS, stranger),
    ).toBeUndefined();
  });
});

describe('a skill folder written into a project', () => {
  const folder = '.claude/skills/new-skill';

  test('writes the files, shows them as hashes, and refuses to go on when one moved since the review', async () => {
    const w = await world();
    expect(await w.folders.inspect(w.project, folder)).toEqual({ exists: false, files: new Map() });
    await w.folders.apply(w.project, folder, {
      write: [
        { path: 'SKILL.md', content: 'one\n' },
        { path: 'docs/a.md', content: 'a\n' },
      ],
      remove: [],
      expected: new Map([
        ['SKILL.md', null],
        ['docs/a.md', null],
      ]),
    });
    expect(await readFile(join(w.project, folder, 'docs', 'a.md'), 'utf8')).toBe('a\n');
    const reading = await w.folders.inspect(w.project, folder);
    expect(reading.files.get('SKILL.md')).toBe(await sha256Hex(text('one\n')));

    await writeFile(join(w.project, folder, 'SKILL.md'), 'edited by hand\n');
    await expect(
      w.folders.apply(w.project, folder, {
        write: [{ path: 'SKILL.md', content: 'two\n' }],
        remove: [],
        expected: new Map([['SKILL.md', reading.files.get('SKILL.md') as string]]),
      }),
    ).rejects.toBeInstanceOf(SkillFolderChanged);
    expect(await readFile(join(w.project, folder, 'SKILL.md'), 'utf8')).toBe('edited by hand\n');
  });

  test('removes exactly what it is asked to and prunes the folders it empties, the skill folder last', async () => {
    const w = await world();
    await w.folders.apply(w.project, folder, {
      write: [{ path: 'docs/a.md', content: 'a\n' }],
      remove: [],
      expected: new Map([['docs/a.md', null]]),
    });
    const reading = await w.folders.inspect(w.project, folder);
    await w.folders.apply(w.project, folder, {
      write: [],
      remove: ['docs/a.md'],
      expected: new Map([['docs/a.md', reading.files.get('docs/a.md') as string]]),
    });
    await expect(lstat(join(w.project, folder))).rejects.toThrow();
    expect((await lstat(join(w.project, '.claude', 'skills'))).isDirectory()).toBe(true);
  });

  test('reads the text of named files for a diff, and says which could not be shown', async () => {
    const w = await world();
    await writeFile(join(w.project, '.claude', 'skills', 'pdf', 'blob.bin'), new Uint8Array([0xff, 0xfe, 0x00]));
    const read = await w.folders.read(w.project, '.claude/skills/pdf', ['SKILL.md', 'blob.bin', 'missing.md']);
    expect(read.files.get('SKILL.md')).toBe(SKILL_DOC);
    expect(read.tooLarge).toEqual(['blob.bin']);
    await expect(w.folders.read(w.project, '.claude/skills/pdf', ['../x'])).rejects.toBeInstanceOf(SkillFolderRefused);
  });

  test('refuses a project nobody registered, a folder that is not a skill folder, and a link anywhere on the way', async () => {
    const w = await world();
    const stranger = join(w.parent, 'stranger');
    await mkdir(stranger, { recursive: true });
    await expect(w.folders.inspect(stranger, folder)).rejects.toBeInstanceOf(SkillFolderRefused);
    await expect(w.folders.inspect(w.project, '.git/hooks')).rejects.toBeInstanceOf(SkillFolderRefused);
    await expect(w.folders.inspect(w.project, '.claude/skills/../../etc')).rejects.toBeInstanceOf(SkillFolderRefused);

    await mkdir(join(w.parent, 'elsewhere'), { recursive: true });
    await symlink(join(w.parent, 'elsewhere'), join(w.project, '.claude', 'skills', 'linked'));
    await expect(w.folders.inspect(w.project, '.claude/skills/linked')).rejects.toBeInstanceOf(SkillFolderRefused);
    await expect(
      w.folders.apply(w.project, '.claude/skills/linked', {
        write: [{ path: 'SKILL.md', content: 'x' }],
        remove: [],
        expected: new Map(),
      }),
    ).rejects.toBeInstanceOf(SkillFolderRefused);
    await expect(lstat(join(w.parent, 'elsewhere', 'SKILL.md'))).rejects.toThrow();
  });
});

describe('the skills a catalog installed into this machine, as the installer reads and prunes them', () => {
  const FILES = [
    { path: 'SKILL.md', content: SKILL_DOC },
    { path: 'scripts/run.sh', content: 'run\n' },
  ];

  test('inspects what the store wrote, reads it back, and removes only files that still have the reviewed hash', async () => {
    const w = await world();
    const assets = new InstalledSkillAssets(w.store);
    expect(await assets.inspect('pdf')).toEqual({ exists: false, files: new Map() });
    await w.store.install('pdf', FILES);

    const reading = await assets.inspect('pdf');
    expect(reading.exists).toBe(true);
    expect([...reading.files.keys()].toSorted()).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(reading.files.get('scripts/run.sh')).toBe(await sha256Hex(text('run\n')));
    expect((await assets.read('pdf', ['SKILL.md', 'nope.md'])).files.get('SKILL.md')).toBe(SKILL_DOC);

    await expect(assets.remove('pdf', new Map([['scripts/run.sh', 'f'.repeat(64)]]))).rejects.toBeInstanceOf(
      SkillFolderChanged,
    );
    expect(await readFile(join(w.installed, 'pdf', 'scripts', 'run.sh'), 'utf8')).toBe('run\n');

    await assets.remove('pdf', new Map([...reading.files]));
    await expect(lstat(join(w.installed, 'pdf'))).rejects.toThrow();
    expect(await assets.inspect('pdf')).toEqual({ exists: false, files: new Map() });
  });

  test('a stale file is removed alone, and the folder stays while anything else is in it', async () => {
    const w = await world();
    const assets = new InstalledSkillAssets(w.store);
    await w.store.install('pdf', FILES);
    const reading = await assets.inspect('pdf');
    await assets.remove('pdf', new Map([['scripts/run.sh', reading.files.get('scripts/run.sh') as string]]));
    expect([...(await assets.inspect('pdf')).files.keys()]).toEqual(['SKILL.md']);
    await expect(lstat(join(w.installed, 'pdf', 'scripts'))).rejects.toThrow();
    expect(await readFile(join(w.installed, 'pdf', 'SKILL.md'), 'utf8')).toBe(SKILL_DOC);
  });

  test('a folder somebody put there by hand lists every file in it, so the installer sees it and never claims it', async () => {
    const w = await world();
    await mkdir(join(w.installed, 'by-hand'), { recursive: true });
    await writeFile(join(w.installed, 'by-hand', 'SKILL.md'), 'mine');
    const reading = await new InstalledSkillAssets(w.store).inspect('by-hand');
    expect(reading.exists).toBe(true);
    expect([...reading.files]).toEqual([['SKILL.md', await sha256Hex(text('mine'))]]);
    await expect(w.store.install('by-hand', FILES)).rejects.toBeInstanceOf(InstalledSkillConflict);
    expect(await readFile(join(w.installed, 'by-hand', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  test('a file added locally after an install is listed by inspect, and an update refuses and keeps it', async () => {
    const w = await world();
    const assets = new InstalledSkillAssets(w.store);
    await w.store.install('pdf', FILES);
    await writeFile(join(w.installed, 'pdf', 'local-notes.md'), 'notes written locally\n');
    await mkdir(join(w.installed, 'pdf', 'mine'), { recursive: true });
    await writeFile(join(w.installed, 'pdf', 'mine', 'deep.md'), 'deep\n');

    const reading = await assets.inspect('pdf');
    expect([...reading.files.keys()].toSorted()).toEqual(
      ['SKILL.md', 'local-notes.md', 'mine/deep.md', 'scripts/run.sh'].toSorted(),
    );

    const next = [{ path: 'SKILL.md', content: `${SKILL_DOC}\nversion two\n` }];
    const refused = await w.store.install('pdf', next).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InstalledSkillConflict);
    expect((refused as Error).message).toContain('pdf/local-notes.md');
    expect((refused as Error).message).not.toContain('notes written locally');
    // Nothing moved: the owned files are as they were, and so are the person's.
    expect(await readFile(join(w.installed, 'pdf', 'local-notes.md'), 'utf8')).toBe('notes written locally\n');
    expect(await readFile(join(w.installed, 'pdf', 'mine', 'deep.md'), 'utf8')).toBe('deep\n');
    expect(await readFile(join(w.installed, 'pdf', 'SKILL.md'), 'utf8')).toBe(SKILL_DOC);
    expect(await readFile(join(w.installed, 'pdf', 'scripts', 'run.sh'), 'utf8')).toBe('run\n');
  });

  test('a link in the folder is listed and refuses an update, and what it points at is untouched', async () => {
    const w = await world();
    await w.store.install('pdf', FILES);
    await writeFile(join(w.parent, 'outside.txt'), 'outside\n');
    await symlink(join(w.parent, 'outside.txt'), join(w.installed, 'pdf', 'link.txt'));
    expect([...(await new InstalledSkillAssets(w.store).inspect('pdf')).files.keys()]).toContain('link.txt');
    await expect(w.store.install('pdf', FILES)).rejects.toBeInstanceOf(InstalledSkillConflict);
    expect(await readFile(join(w.parent, 'outside.txt'), 'utf8')).toBe('outside\n');
    expect((await lstat(join(w.installed, 'pdf', 'link.txt'))).isSymbolicLink()).toBe(true);
  });

  test('an update with nothing foreign in the folder replaces owned files and drops the ones the new version lacks', async () => {
    const w = await world();
    await w.store.install('pdf', FILES);
    const next = [
      { path: 'SKILL.md', content: `${SKILL_DOC}\nversion two\n` },
      { path: 'docs/guide.md', content: 'guide\n' },
    ];
    await w.store.install('pdf', next);
    expect(await readFile(join(w.installed, 'pdf', 'SKILL.md'), 'utf8')).toBe(next[0]?.content as string);
    expect(await readFile(join(w.installed, 'pdf', 'docs', 'guide.md'), 'utf8')).toBe('guide\n');
    await expect(lstat(join(w.installed, 'pdf', 'scripts'))).rejects.toThrow();
    expect((await w.store.paths('pdf')).toSorted()).toEqual(['SKILL.md', 'docs/guide.md']);
  });

  test('removal and uninstall delete only owned files and leave a folder holding anything else', async () => {
    const w = await world();
    const assets = new InstalledSkillAssets(w.store);
    await w.store.install('pdf', FILES);
    await writeFile(join(w.installed, 'pdf', 'local-notes.md'), 'mine\n');
    await w.store.uninstall('pdf');
    expect(await readFile(join(w.installed, 'pdf', 'local-notes.md'), 'utf8')).toBe('mine\n');
    await expect(lstat(join(w.installed, 'pdf', 'SKILL.md'))).rejects.toThrow();
    expect([...(await assets.inspect('pdf')).files.keys()]).toEqual(['local-notes.md']);
    // A directory is never removed with what is in it, even when a caller names it.
    await mkdir(join(w.installed, 'pdf', 'mine'), { recursive: true });
    await writeFile(join(w.installed, 'pdf', 'mine', 'deep.md'), 'deep\n');
    await w.store.removePaths('pdf', ['mine']);
    expect(await readFile(join(w.installed, 'pdf', 'mine', 'deep.md'), 'utf8')).toBe('deep\n');
  });
});

// ── the runtime half, with Runtimes and the config writer stood in ─────────────────────────────────────────────────

const PROVENANCE = {
  publisher: 'daemon-1',
  publisherName: 'laptop',
  catalogId: 'cat_x',
  catalogName: 'Team',
  itemId: 'itm_x',
  kind: 'skill' as const,
  name: 'pdf',
  version: 1,
  digest: `sha256:${'0'.repeat(64)}`,
};
const CHANGE = {
  kind: 'catalog.install' as const,
  name: 'pdf',
  component: { kind: 'skills' as const, items: ['pdf'] },
  files: [{ path: 'SKILL.md', content: SKILL_DOC }],
  profile: 'default',
  installedFrom: PROVENANCE as never,
  replace: false,
};
const written: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] } as never;

function runtimeWorld(options: { layer?: 'written' | 'refused'; runtimes?: boolean } = {}) {
  const items = new Map<string, SkillsItem>();
  const calls: string[] = [];
  const installs: string[] = [];
  const store = {
    install: async (name: string) => {
      installs.push(`install ${name}`);
    },
    uninstall: async (name: string) => {
      installs.push(`uninstall ${name}`);
    },
  };
  const runtimes = {
    list: async () => [{ id: 'claude-default', harness: 'claude-code', profile: 'default' }],
    profiles: async () => [{ name: 'default', layers: ['mcp/acme'], etag: 'p1' }],
    changeProfileLayers: async (change: { kind: string; layer: string }) => {
      calls.push(`${change.kind} ${change.layer}`);
      return options.layer === 'refused'
        ? { kind: 'refused' as const, code: 'fleet_change_refused' as const, sentence: 'the profile is locked' }
        : { kind: 'written' as const, profiles: ['default'] };
    },
  };
  const runtime = skillsCatalogRuntime({
    runtimes: () => (options.runtimes === false ? undefined : (runtimes as never)),
    items: () => items,
    writeItem: async (name, patch, ifMatch) => {
      calls.push(`write ${name} ${ifMatch ?? 'any'}`);
      items.set(name, patch as never);
      return written;
    },
    removeItem: async name => {
      calls.push(`remove ${name}`);
      items.delete(name);
      return written;
    },
    store: store as never,
  });
  return { runtime, items, calls, installs };
}

describe('installing a catalog skill into a runtime', () => {
  test('writes the files, the item and the profile layer, and answers the component exactly as it is stored', async () => {
    const w = runtimeWorld();
    expect(await w.runtime.runtimes()).toEqual({
      runtimes: [{ id: 'claude-default', name: 'claude-default', profile: 'default', harness: 'claude' }],
    });
    expect(await w.runtime.profiles()).toEqual({ profiles: [{ name: 'default' }] });
    const stored = await w.runtime.installCatalogItem(CHANGE, undefined);
    expect(w.installs).toEqual(['install pdf']);
    expect(w.calls).toEqual(['write pdf absent', 'add skills/pdf']);
    expect(stored.component).toEqual({ items: ['pdf'], installedFrom: PROVENANCE });
    expect(await w.runtime.storedComponent('pdf')).toEqual(stored.component);
  });

  test('an update over a folder with a file added by hand is a conflict that names the path, and writes nothing else', async () => {
    const w = await world();
    const items = new Map<string, SkillsItem>([['pdf', { items: ['pdf'] }]]);
    const calls: string[] = [];
    const runtime = skillsCatalogRuntime({
      runtimes: () =>
        ({
          list: async () => [],
          profiles: async () => [{ name: 'default', layers: ['skills/pdf'], etag: 'p1' }],
          changeProfileLayers: async () => {
            calls.push('layers');
            return { kind: 'written' as const, profiles: ['default'] };
          },
        }) as never,
      items: () => items,
      writeItem: async () => {
        calls.push('write');
        return written;
      },
      removeItem: async () => {
        calls.push('remove');
        return written;
      },
      store: w.store,
    });
    await runtime.installCatalogItem({ ...CHANGE, replace: true }, undefined);
    await writeFile(join(w.installed, 'pdf', 'local-notes.md'), 'notes written locally\n');
    calls.length = 0;
    const refusal = await runtime
      .installCatalogItem(
        { ...CHANGE, replace: true, files: [{ path: 'SKILL.md', content: `${SKILL_DOC}\nversion two\n` }] },
        undefined,
      )
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CatalogItemRefusal);
    expect(refusal).toMatchObject({ code: 'catalog_install_conflict' });
    expect((refusal as Error).message).toContain('pdf/local-notes.md');
    expect(calls).toEqual([]);
    expect(await readFile(join(w.installed, 'pdf', 'local-notes.md'), 'utf8')).toBe('notes written locally\n');
    expect(await readFile(join(w.installed, 'pdf', 'SKILL.md'), 'utf8')).toBe(SKILL_DOC);
  });

  test('refuses a name that is already a skill here that no install of ours put there, writing nothing', async () => {
    const w = runtimeWorld();
    w.items.set('pdf', { items: ['pdf'] });
    await expect(w.runtime.installCatalogItem(CHANGE, undefined)).rejects.toMatchObject({
      code: 'catalog_install_conflict',
    });
    expect(w.installs).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  test('takes back what it wrote when the profile refuses, so nothing half-installed is left', async () => {
    const w = runtimeWorld({ layer: 'refused' });
    await expect(w.runtime.installCatalogItem(CHANGE, undefined)).rejects.toBeInstanceOf(CatalogItemRefusal);
    expect(w.installs).toEqual(['install pdf', 'uninstall pdf']);
    expect(w.items.has('pdf')).toBe(false);
  });

  test('says in words when Runtimes is off or the profile is unknown, and writes nothing', async () => {
    await expect(runtimeWorld({ runtimes: false }).runtime.installCatalogItem(CHANGE, undefined)).rejects.toMatchObject(
      {
        code: 'catalog_target_unknown',
      },
    );
    const w = runtimeWorld();
    await expect(w.runtime.installCatalogItem({ ...CHANGE, profile: 'nope' }, undefined)).rejects.toMatchObject({
      code: 'catalog_target_unknown',
    });
    expect(w.installs).toEqual([]);
  });

  test('removal takes the layer out of every profile, then the item, and only for a proposal it holds', async () => {
    const w = runtimeWorld();
    await w.runtime.installCatalogItem(CHANGE, undefined);
    w.calls.length = 0;
    const proposal = await w.runtime.propose({ kind: 'component.remove', name: 'pdf', removeFromProfiles: true });
    await w.runtime.apply(proposal.id, undefined, { claim: () => false, agent: false });
    expect(w.calls).toEqual(['remove-everywhere skills/pdf', 'remove pdf']);
    await expect(w.runtime.apply(proposal.id, undefined, { claim: () => false, agent: false })).rejects.toMatchObject({
      code: 'fleet_change_unknown',
    });
  });
});
