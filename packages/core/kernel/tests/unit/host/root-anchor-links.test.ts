/**
 * `RootsPort.root(name, { subfolder, within })` on the real disk: the optional ANCHOR above a scoped folder. With one,
 * every folder from the anchor's FIRST CHILD down to the scoped folder is looked at without being followed, and a link
 * at any of them is refused `link_escape` by every door; the anchor itself and its ancestors are not looked at (a
 * symlinked project folder, or a project under a linked workspace folder, works); an anchor equal to the scoped folder
 * walks nothing; an anchor that is not the folder or an ancestor of it (compared by component, never by string prefix)
 * names no folder and every door answers `outside`. Without one the handle is exactly what it was.
 *
 * Fixture content only: the hostile target holds a REAL skills tree (`<name>/SKILL.md`) so a missed refusal would
 * list and read it. Each test names the door it proves.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { anchorWalk } from '../../../host/root-rules.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const STOLEN = 'FAKE-OUTSIDE-SKILL-TEXT-5d1f';
const OWN = 'FAKE-PROJECT-SKILL-TEXT-91ae';
const NAME = 'review';

async function skill(folder: string, text: string): Promise<void> {
  await mkdir(`${folder}/${NAME}`, { recursive: true });
  await writeFile(`${folder}/${NAME}/SKILL.md`, text);
}

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-anchor-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  const project = `${parent}/workspace/proj`;
  await skill(`${project}/.claude/skills`, OWN);
  // The hostile targets: a REAL skills tree outside the project, in both shapes.
  await skill(`${parent}/outside/skills`, STOLEN);
  await skill(`${parent}/outside/claude/skills`, STOLEN);
  const rootsFor = (declared: readonly RootName[] = ['imports']) =>
    rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      declared,
      () => undefined,
    );
  const handle = (scope: { subfolder?: string; within?: string }, name: RootName = 'imports'): RootHandle =>
    rootsFor([name]).root(name, scope);
  return { parent, home, project, rootsFor, handle };
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

/** Every door that can reach into the scoped folder, each asked for the stolen entry. */
async function doors(root: RootHandle, forged?: string): Promise<Record<string, string | undefined>> {
  const resolved = root.resolve('');
  const found = root.resolve(`${NAME}/SKILL.md`);
  // A refused scope refuses even the lexical half (`outside`); its doors are then asked with a forged absolute name.
  const folder = (resolved.ok ? resolved.value : forged) as FencedPath;
  const file = (found.ok ? found.value : `${forged}/${NAME}/SKILL.md`) as FencedPath;
  return {
    list: await refusalOf(() => root.list(folder)),
    entries: await refusalOf(() => root.entries(folder)),
    readText: await refusalOf(() => root.readText(file)),
    readBytes: await refusalOf(() => root.readBytes(file)),
    stat: await refusalOf(() => root.stat(file)),
    lstat: await refusalOf(() => root.lstat(file)),
    realPath: await refusalOf(() => root.realPath(file)),
  };
}

const ALL_REFUSED = {
  list: 'link_escape',
  entries: 'link_escape',
  readText: 'link_escape',
  readBytes: 'link_escape',
  stat: 'link_escape',
  lstat: 'link_escape',
  realPath: 'link_escape',
};
const NONE_REFUSED = {
  list: undefined,
  entries: undefined,
  readText: undefined,
  readBytes: undefined,
  stat: undefined,
  lstat: undefined,
  realPath: undefined,
};

describe('anchorWalk: the one rule both hosts read', () => {
  test('the folder itself or an ancestor of it names the folders from the anchor’s first child down, the anchor excluded', () => {
    expect(anchorWalk('/p/.claude/skills', '/p')).toEqual(['/p/.claude', '/p/.claude/skills']);
    expect(anchorWalk('/p/.claude/skills', '/p/.claude')).toEqual(['/p/.claude/skills']);
  });

  test('the anchor is the scoped folder itself: allowed, and the walk is empty (it checks nothing, as no anchor)', () => {
    expect(anchorWalk('/p/.claude/skills', '/p/.claude/skills')).toEqual([]);
  });

  test('a sibling or a prefix of a name is not an ancestor: components, never a string prefix', () => {
    for (const within of ['/p/.claude2', '/p/.claud', '/p/.claude/skill', '/p/.claude/skills2', '/q', '/pp'])
      expect(anchorWalk('/p/.claude/skills', within)).toBeUndefined();
  });

  test('a longer anchor, a relative one, the root, a NUL and a dot segment are not ancestors', () => {
    for (const within of [
      '/p/.claude/skills/review',
      'p',
      '',
      '/',
      '/p\0',
      '/p/./.claude',
      '/p/../p',
      '/p//.claude',
      '/p/',
    ])
      expect(anchorWalk('/p/.claude/skills', within)).toBeUndefined();
  });
});

describe('an anchored scope refuses a link from the anchor down to the scoped folder, at every door', () => {
  test('without an anchor the handle is exactly what it was: a legit folder lists and reads', async () => {
    const w = await world();
    const root = w.handle({ subfolder: `${w.project}/.claude/skills` });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const file = root.resolve(`${NAME}/SKILL.md`);
    if (!file.ok) throw new Error('refused');
    expect(await root.readText(file.value)).toBe(OWN);
  });

  test('without an anchor a linked scoped folder is followed as it always was (the unchanged case)', async () => {
    const w = await world();
    await rm(`${w.project}/.claude/skills`, { recursive: true });
    await symlink(`${w.parent}/outside/skills`, `${w.project}/.claude/skills`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills` });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const file = root.resolve(`${NAME}/SKILL.md`);
    if (!file.ok) throw new Error('refused');
    expect(await root.readText(file.value)).toBe(STOLEN);
  });

  test('with an anchor a legit folder lists and reads at every door', async () => {
    const w = await world();
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const file = root.resolve(`${NAME}/SKILL.md`);
    if (!file.ok) throw new Error('refused');
    expect(await root.readText(file.value)).toBe(OWN);
  });

  test('the scoped folder is itself a link out: every door refuses it link_escape and nothing is listed or read', async () => {
    const w = await world();
    await rm(`${w.project}/.claude/skills`, { recursive: true });
    await symlink(`${w.parent}/outside/skills`, `${w.project}/.claude/skills`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project });
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });

  test('the scoped folder SITS UNDER a link out (.claude -> outside): every door refuses it link_escape', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project });
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });

  test('the anchor is the scoped folder itself: allowed and not refused, it lists as the same folder without an anchor does', async () => {
    const w = await world();
    const folder = `${w.project}/.claude/skills`;
    const root = w.handle({ subfolder: folder, within: folder });
    expect(root.resolve('')).toMatchObject({ ok: true });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const listed = root.resolve('');
    if (!listed.ok) throw new Error('refused');
    expect(await root.list(listed.value)).toEqual([NAME]);
  });

  test('the anchor is the scoped folder itself and that folder is a link: the walk is empty, so it is followed like no anchor', async () => {
    const w = await world();
    await rm(`${w.project}/.claude/skills`, { recursive: true });
    await symlink(`${w.parent}/outside/skills`, `${w.project}/.claude/skills`);
    const folder = `${w.project}/.claude/skills`;
    expect(await doors(w.handle({ subfolder: folder, within: folder }))).toEqual(
      await doors(w.handle({ subfolder: folder })),
    );
  });

  test('the anchor is the middle folder and the folder below it is the link: refused', async () => {
    const w = await world();
    await rm(`${w.project}/.claude/skills`, { recursive: true });
    await symlink(`${w.parent}/outside/skills`, `${w.project}/.claude/skills`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: `${w.project}/.claude` });
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });

  test('the anchor itself being a link is fine: a symlinked project folder still lists and reads (the anchor is never looked at)', async () => {
    const w = await world();
    await symlink(w.project, `${w.parent}/workspace/proj-link`);
    const linked = `${w.parent}/workspace/proj-link`;
    const root = w.handle({ subfolder: `${linked}/.claude/skills`, within: linked });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const folder = root.resolve('');
    if (!folder.ok) throw new Error('refused');
    expect(await root.list(folder.value)).toEqual([NAME]);
    const file = root.resolve(`${NAME}/SKILL.md`);
    if (!file.ok) throw new Error('refused');
    expect(await root.readText(file.value)).toBe(OWN);
  });

  test('a symlinked project folder with a hostile link at its first child (.claude) is still link_escape', async () => {
    const w = await world();
    await symlink(w.project, `${w.parent}/workspace/proj-link`);
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    const linked = `${w.parent}/workspace/proj-link`;
    expect(await doors(w.handle({ subfolder: `${linked}/.claude/skills`, within: linked }))).toEqual(ALL_REFUSED);
  });

  test('the first child of the anchor being a link out is refused, whatever folder is scoped below it', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    expect(await doors(w.handle({ subfolder: `${w.project}/.claude`, within: w.project }))).toEqual(ALL_REFUSED);
  });

  test('a project UNDER a linked workspace folder (the anchor under a link) still works', async () => {
    const w = await world();
    await symlink(`${w.parent}/workspace`, `${w.parent}/ws-link`);
    const project = `${w.parent}/ws-link/proj`;
    const root = w.handle({ subfolder: `${project}/.claude/skills`, within: project });
    expect(await doors(root)).toEqual(NONE_REFUSED);
    const file = root.resolve(`${NAME}/SKILL.md`);
    if (!file.ok) throw new Error('refused');
    expect(await root.readText(file.value)).toBe(OWN);
    const folder = root.resolve('');
    if (!folder.ok) throw new Error('refused');
    expect(await root.list(folder.value)).toEqual([NAME]);
  });

  test('a hostile link below a project under a linked workspace folder is still refused', async () => {
    const w = await world();
    await symlink(`${w.parent}/workspace`, `${w.parent}/ws-link`);
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    const project = `${w.parent}/ws-link/proj`;
    const root = w.handle({ subfolder: `${project}/.claude/skills`, within: project });
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });

  test('a link INSIDE the scoped folder that stays inside it behaves as the kernel documents (followed), anchored or not', async () => {
    const w = await world();
    const skills = `${w.project}/.claude/skills`;
    await symlink(`${skills}/${NAME}`, `${skills}/alias`);
    for (const scope of [{ subfolder: skills }, { subfolder: skills, within: w.project }]) {
      const root = w.handle(scope);
      const alias = root.resolve('alias/SKILL.md');
      if (!alias.ok) throw new Error('refused');
      expect(await root.readText(alias.value)).toBe(OWN);
    }
  });

  test('a link inside the scoped folder that leads OUT is still link_escape, anchored or not', async () => {
    const w = await world();
    const skills = `${w.project}/.claude/skills`;
    await symlink(`${w.parent}/outside/skills/${NAME}`, `${skills}/stolen`);
    for (const scope of [{ subfolder: skills }, { subfolder: skills, within: w.project }]) {
      const root = w.handle(scope);
      const file = root.resolve('stolen/SKILL.md');
      if (!file.ok) throw new Error('refused');
      expect(await refusalOf(() => root.readText(file.value))).toBe('link_escape');
    }
  });

  test('a scoped folder that is not there yet is not a link: the anchored door answers as an unanchored one does', async () => {
    const w = await world();
    const missing = `${w.project}/.agents/skills`;
    const anchored = w.handle({ subfolder: missing, within: w.project });
    const plain = w.handle({ subfolder: missing });
    expect(await doors(anchored)).toEqual(await doors(plain));
  });
});

describe('a folder the walk cannot look at, a hostile spelling of the anchor, and the lexical half', () => {
  const kind = (error: unknown): { refusal?: string; message: string } => ({
    ...(error instanceof RootError ? { refusal: error.refusal } : {}),
    message: error instanceof Error ? error.message : String(error),
  });
  const listError = async (root: RootHandle): Promise<{ refusal?: string; message: string } | undefined> => {
    const folder = root.resolve('');
    if (!folder.ok) return { refusal: folder.error, message: '' };
    try {
      await root.list(folder.value);
      return undefined;
    } catch (error) {
      return kind(error);
    }
  };

  test('a component with no permission (EACCES) is refused with a content-free RootError, never allowed', async () => {
    if (process.getuid?.() === 0) return;
    const w = await world();
    await chmod(`${w.project}/.claude`, 0o000);
    try {
      const refused = await listError(w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project }));
      expect(refused?.refusal).toBe('link_escape');
      expect(refused?.message).toBe('root refused: link_escape');
      expect(refused?.message).not.toContain(w.parent);
    } finally {
      await chmod(`${w.project}/.claude`, 0o700);
    }
  });

  test('a component that is a FILE where a folder should be (ENOTDIR) is refused with a content-free RootError', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await writeFile(`${w.project}/.claude`, 'not a folder');
    const refused = await listError(w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project }));
    expect(refused?.refusal).toBe('link_escape');
    expect(refused?.message).toBe('root refused: link_escape');
    expect(refused?.message).not.toContain(w.parent);
  });

  test('a dangling link and a link loop at the anchor’s first child are link_escape', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/nowhere`, `${w.project}/.claude`);
    const scope = { subfolder: `${w.project}/.claude/skills`, within: w.project };
    expect(await doors(w.handle(scope))).toEqual(ALL_REFUSED);
    await rm(`${w.project}/.claude`);
    await symlink(`${w.project}/.claude`, `${w.project}/.claude`);
    expect(await doors(w.handle(scope))).toEqual(ALL_REFUSED);
  });

  test('an anchor spelled with a trailing slash, relative, or in another case names no folder: outside at every door', async () => {
    const w = await world();
    const folder = `${w.project}/.claude/skills`;
    const refused = {
      list: 'outside',
      entries: 'outside',
      readText: 'outside',
      readBytes: 'outside',
      stat: 'outside',
      lstat: 'outside',
      realPath: 'outside',
    };
    for (const within of [
      `${w.project}/`,
      'workspace/proj',
      `${w.parent}/Workspace/proj`,
      `${w.parent}/WORKSPACE/proj`,
    ])
      expect({ within, doors: await doors(w.handle({ subfolder: folder, within }), folder) }).toEqual({
        within,
        doors: refused,
      });
  });

  test('resolve is lexical: under a hostile link it answers ok, and every call that reaches the disk refuses', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project });
    expect(root.resolve('')).toMatchObject({ ok: true });
    expect(root.resolve(`${NAME}/SKILL.md`)).toMatchObject({ ok: true });
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });
});

describe('an anchor that is not the folder or an ancestor of it names no folder', () => {
  const FOLDER = (project: string) => `${project}/.claude/skills`;
  const refused = {
    list: 'outside',
    entries: 'outside',
    readText: 'outside',
    readBytes: 'outside',
    stat: 'outside',
    lstat: 'outside',
    realPath: 'outside',
  };

  test('a sibling that shares a string prefix, a deeper folder and a relative anchor are refused outside at every door', async () => {
    const w = await world();
    for (const within of [
      `${w.project}/.claude2`,
      `${w.project}/.claud`,
      `${w.project}/.claude/skills/${NAME}`,
      `${w.parent}/workspace/proj2`,
      'proj',
      '/',
      `${w.project}/../proj`,
    ]) {
      const root = w.handle({ subfolder: FOLDER(w.project), within });
      // refused at once, before any disk: the lexical half already answers `outside`
      expect({ within, resolve: root.resolve('') }).toEqual({ within, resolve: { ok: false, error: 'outside' } });
      expect({ within, doors: await doors(root, FOLDER(w.project)) }).toEqual({ within, doors: refused });
    }
  });

  test('a root that takes no absolute folder refuses any anchor', async () => {
    const w = await world();
    const downloads = w.rootsFor(['downloads']).root('downloads', { within: w.project });
    expect(downloads.resolve('')).toEqual({ ok: false, error: 'outside' });
    expect(await doors(downloads, `${w.home}/state/downloads`)).toEqual(refused);
  });

  test('a root that takes no absolute folder refuses an anchor even when it IS an ancestor of that root’s own folder', async () => {
    const w = await world();
    // `downloads` lives under the home, so the home is a true ancestor of it: only the root’s kind refuses the anchor
    const downloads = w.rootsFor(['downloads']).root('downloads', { within: w.home });
    expect(downloads.resolve('')).toEqual({ ok: false, error: 'outside' });
    expect(await doors(downloads, `${w.home}/state/downloads`)).toEqual(refused);
  });

  test('an anchor with no scoped folder names no folder', async () => {
    const w = await world();
    const root = w.rootsFor(['imports']).root('imports', { within: w.project });
    expect(root.resolve('')).toEqual({ ok: false, error: 'outside' });
    expect(await doors(root, w.project)).toEqual(refused);
  });
});

describe('the other roots scoped to an absolute folder take the anchor the same way', () => {
  test('harness-history refuses a link below the anchor at every door', async () => {
    const w = await world();
    await rm(`${w.project}/.claude`, { recursive: true });
    await symlink(`${w.parent}/outside/claude`, `${w.project}/.claude`);
    const root = w.handle({ subfolder: `${w.project}/.claude/skills`, within: w.project }, 'harness-history');
    expect(await doors(root)).toEqual(ALL_REFUSED);
  });
});

describe('the project-files root takes the anchor the same way (S179)', () => {
  const projectFiles = async (w: Awaited<ReturnType<typeof world>>, scope: { subfolder: string; within?: string }) =>
    rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: w.home, plugin: 'mcp', worktrees: `${w.home}-worktrees` },
      ['project-files'],
      () => undefined,
      { random: () => 'rnd', projectFiles: ['.mcp.json'] },
    ).root('project-files', scope);

  test('S179 a symlinked project folder named as its own anchor still writes .mcp.json', async () => {
    const w = await world();
    const linked = `${w.parent}/linked-project`;
    await symlink(w.project, linked);
    const root = await projectFiles(w, { subfolder: linked, within: linked });
    const name = root.resolve('.mcp.json');
    if (!name.ok) throw new Error(name.error);
    await root.writeText(name.value, '{"mcpServers":{}}\n');
    expect(await readFile(`${w.project}/.mcp.json`, 'utf8')).toBe('{"mcpServers":{}}\n');
  });

  test('S179 the same symlinked project folder with no anchor is refused link_escape: its realpath is not its spelling', async () => {
    const w = await world();
    const linked = `${w.parent}/linked-project`;
    await symlink(w.project, linked);
    const root = await projectFiles(w, { subfolder: linked });
    const name = root.resolve('.mcp.json');
    if (!name.ok) throw new Error(name.error);
    expect(await refusalOf(() => root.writeText(name.value, 'x'))).toBe('link_escape');
    expect(await refusalOf(() => root.readText(name.value))).toBe('link_escape');
  });
});
