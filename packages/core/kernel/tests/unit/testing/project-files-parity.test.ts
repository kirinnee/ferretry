/**
 * The testing host's `project-files` root stays in step with the real host's (S179, K3): the same rules decide both
 * (`manifest/project-files.ts`, `lexicalInRoot`), with the same refusals in the same order, so a plugin's unit test meets
 * what production does. The real host is booted for real (its own disk, its manifest wiring); each case is spelled with
 * that host's own paths, and a case that fails for a reason that is not a root refusal answers only that it failed.
 */
import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { RootError } from '../../../host/roots.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED = ['.mcp.json', '.claude/skills/*/**', '.agents/skills/*/**'];

interface Seen {
  mcp?: KernelPorts;
  stranger?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'mcp',
      title: 'MCP',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['project-files', 'downloads'], projectFiles: DECLARED, setMode: true },
    }),
    {
      build: ({ kernel }) => {
        seen.mcp = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'stranger',
      title: 'Stranger',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['downloads'] },
    }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    },
  ),
];

type Answer = { readonly ok: unknown } | { readonly refused: string } | { readonly failed: true };
const answer = async (call: () => unknown): Promise<Answer> => {
  try {
    return { ok: (await call()) ?? null };
  } catch (error) {
    return error instanceof RootError ? { refused: error.refusal } : { failed: true };
  }
};

/** The paths one host spells, and how it plants what a case needs in its world. */
interface Places {
  readonly proj: string;
  readonly other: string;
  readonly home: string;
  /** A link at `proj/<relative>` pointing outside the project. */
  readonly plantLink: (relative: string) => Promise<void>;
  /** A file with a second name at `proj/<relative>`. */
  readonly plantHardLink: (relative: string, text: string) => Promise<void>;
  /** The plugin's own `downloads` folder `pack` holding `SKILL.md`: the source of a copy. */
  readonly plantSource: () => Promise<void>;
}

async function cases(seen: Seen, places: Places): Promise<readonly (readonly [string, Answer])[]> {
  const mcp = seen.mcp as KernelPorts;
  const stranger = seen.stranger as KernelPorts;
  const at = (root: RootHandle, path: string): FencedPath => {
    const resolved = root.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  const project = mcp.roots.root('project-files', { subfolder: places.proj });
  const second = mcp.roots.root('project-files', { subfolder: places.other });
  const fenced = mcp.roots.root('project-files', { subfolder: `${places.home}/state/proj` });
  const bytes = new TextEncoder().encode('x');
  const resolveAnswer = (root: RootHandle, path: string): Answer => {
    const found = root.resolve(path);
    return found.ok ? { ok: 'resolved' } : { refused: found.error };
  };
  const writes = async (root: RootHandle, names: readonly string[]) => {
    const out: (readonly [string, Answer])[] = [];
    for (const name of names)
      out.push([`write ${name}`, await answer(() => root.writeText(at(root, name), 'text'))] as const);
    return out;
  };
  const downloads = mcp.roots.root('downloads');
  /**
   * `copyTree` in both directions and with the `link` option (H1, Md2): a copy lands at a grant, a copy aimed above one or
   * outside the set is refused, a source above a grant is refused by ITS handle, and no link is made into a project folder
   * nor from one.
   */
  const copyCases = async (): Promise<readonly (readonly [string, Answer])[]> => {
    await places.plantSource();
    const pack = at(downloads, 'pack');
    const out = [] as (readonly [string, Answer])[];
    const copy = async (label: string, call: () => Promise<unknown>) => out.push([label, await answer(call)]);
    await copy('copy a downloads folder into a grant', () =>
      project.copyTree(downloads, pack, at(project, '.claude/skills/c1')),
    );
    await copy('the copy landed', () => project.readText(at(project, '.claude/skills/c1/SKILL.md')));
    await copy('copy into a folder above a grant', () =>
      project.copyTree(downloads, pack, at(project, '.claude/skills')),
    );
    await copy('copy into a name outside the set', () => project.copyTree(downloads, pack, at(project, 'other')));
    await copy('copyTree link into a grant', () =>
      project.copyTree(downloads, pack, at(project, '.claude/skills/c2'), { link: true }),
    );
    await copy('copyTree link above a grant', () =>
      project.copyTree(downloads, pack, at(project, '.claude/skills'), { link: true }),
    );
    await copy('copyTree link from a project folder into a project folder', () =>
      project.copyTree(project, at(project, '.claude/skills/c1'), at(project, '.claude/skills/c3'), { link: true }),
    );
    await copy('copy FROM a folder above a grant into a project folder', () =>
      project.copyTree(project, at(project, '.claude'), at(project, '.claude/skills/c5')),
    );
    await copy('copy a project folder into downloads', () =>
      downloads.copyTree(project, at(project, '.claude/skills/c1'), at(downloads, 'got')),
    );
    await copy('the project copy landed', () => downloads.readText(at(downloads, 'got/SKILL.md')));
    await copy('copy FROM a folder above a grant', () =>
      downloads.copyTree(project, at(project, '.claude'), at(downloads, 'got2')),
    );
    await copy('copy FROM the skills folder above a grant', () =>
      downloads.copyTree(project, at(project, '.claude/skills'), at(downloads, 'got3')),
    );
    await copy('copy FROM a name outside the set', () =>
      downloads.copyTree(project, at(project, 'src'), at(downloads, 'got4')),
    );
    await copy('copyTree link FROM a project folder into downloads', () =>
      downloads.copyTree(project, at(project, '.claude/skills/c1'), at(downloads, 'linked'), { link: true }),
    );
    await copy('copyTree link FROM a folder above a grant', () =>
      downloads.copyTree(project, at(project, '.claude'), at(downloads, 'linked2'), { link: true }),
    );
    await copy('a stranger handle as the source', () =>
      project.copyTree(
        stranger.roots.root('downloads'),
        at(stranger.roots.root('downloads'), 'pack'),
        at(project, '.claude/skills/c4'),
      ),
    );
    return out;
  };
  /** A write with a mode, then replaceExisting over it: the kept mode is read back (m1: the twin must keep it too). */
  const modeCases = async (): Promise<readonly (readonly [string, Answer])[]> => {
    const file = at(project, '.claude/skills/md/a.md');
    const out = [] as (readonly [string, Answer])[];
    out.push(['write with mode 0755', await answer(() => project.writeText(file, 'one', { mode: 0o755 }))]);
    out.push(['mode after the write', await answer(async () => (await project.stat(file))?.mode)]);
    out.push([
      'replaceExisting without a mode',
      await answer(() => project.writeText(file, 'two', { replaceExisting: true })),
    ]);
    out.push(['mode kept by replaceExisting', await answer(async () => (await project.stat(file))?.mode)]);
    out.push([
      'replaceExisting with a mode',
      await answer(() => project.writeText(file, 'three', { replaceExisting: true, mode: 0o640 })),
    ]);
    out.push(['mode set by replaceExisting', await answer(async () => (await project.stat(file))?.mode)]);
    return out;
  };
  /** The cases that plant a link or a hard link first: they run LAST, so what they plant never changes an earlier answer. */
  const plantedCases = async (): Promise<readonly (readonly [string, Answer])[]> => {
    const planted = [] as (readonly [string, Answer])[];
    await places.plantLink('.mcp.json');
    planted.push([
      'write through a link at the leaf',
      await answer(() => project.writeText(at(project, '.mcp.json'), 'x')),
    ]);
    planted.push([
      'replaceExisting through a link at the leaf',
      await answer(() => project.writeText(at(project, '.mcp.json'), 'x', { replaceExisting: true })),
    ]);
    planted.push([
      'publish through a link at the leaf',
      await answer(() => project.publish(at(project, '.mcp.json'), bytes)),
    ]);
    planted.push(['read through a link at the leaf', await answer(() => project.readText(at(project, '.mcp.json')))]);
    await places.plantLink('.claude');
    planted.push([
      'write below a link at a folder level',
      await answer(() => project.writeText(at(project, '.claude/skills/x/a.md'), 'x')),
    ]);
    planted.push([
      'makeDirectory below a link at a folder level',
      await answer(() => project.makeDirectory(at(project, '.claude/skills/x'))),
    ]);
    await places.plantHardLink('.agents/skills/h/SKILL.md', 'hard');
    planted.push([
      'write a hard-linked file',
      await answer(() => project.writeText(at(project, '.agents/skills/h/SKILL.md'), 'x')),
    ]);
    planted.push([
      'replaceExisting a hard-linked file',
      await answer(() => project.writeText(at(project, '.agents/skills/h/SKILL.md'), 'x', { replaceExisting: true })),
    ]);
    planted.push([
      'publish over a hard-linked file',
      await answer(() => project.publish(at(project, '.agents/skills/h/SKILL.md'), bytes)),
    ]);
    planted.push([
      'read a hard-linked file',
      await answer(() => project.readText(at(project, '.agents/skills/h/SKILL.md'))),
    ]);
    planted.push([
      'readDurable a hard-linked file',
      await answer(() => project.readDurable(at(project, '.agents/skills/h/SKILL.md'))),
    ]);
    planted.push([
      'setMode a hard-linked file',
      await answer(() => project.setMode(at(project, '.agents/skills/h/SKILL.md'), 0o644)),
    ]);
    // remove never follows the leaf: a link at a grant is unlinked as a link; a link ABOVE the name stays refused (M1)
    await places.plantLink('.agents/skills/rl');
    planted.push(['remove a link at a grant', await answer(() => project.remove(at(project, '.agents/skills/rl')))]);
    planted.push([
      'the removed link is gone',
      await answer(async () => (await project.lstat(at(project, '.agents/skills/rl')))?.kind ?? 'none'),
    ]);
    await places.plantLink('.agents/skills/rm');
    planted.push([
      'remove below a link at a folder level',
      await answer(() => project.remove(at(project, '.agents/skills/rm/a.md'))),
    ]);
    planted.push([
      'remove a link at the leaf of a file name',
      await answer(() => project.remove(at(project, '.mcp.json'))),
    ]);
    return planted;
  };
  return [
    ...(await writes(project, [
      '.mcp.json',
      '.claude/skills/x/SKILL.md',
      '.claude/skills/x/a/b/c.md',
      '.agents/skills/y/data.txt',
      '.claude/other',
      '.claude/skills/x',
      '.claude/skills',
      'package.json',
      '.mcp.json/child',
      '.mcp.json2',
      '.CLAUDE/skills/x/a',
      '.MCP.json',
      '.claude/Skills/x/a',
    ])),
    ['read what was written', await answer(() => project.readText(at(project, '.mcp.json')))],
    ['read a name outside the set', await answer(() => project.readText(at(project, 'package.json')))],
    [
      'readBytes window out of range',
      await answer(() => project.readBytes(at(project, '.mcp.json'), { offset: 0, length: 1 << 30 })),
    ],
    [
      'readTail of a declared name',
      await answer(async () => (await project.readTail(at(project, '.mcp.json'), 2)).size),
    ],
    [
      'exclusive over an existing name',
      await answer(() => project.writeText(at(project, '.mcp.json'), 'x', { exclusive: true })),
    ],
    [
      'replaceExisting of a missing name',
      await answer(() => project.writeText(at(project, '.claude/skills/new/a.md'), 'x', { replaceExisting: true })),
    ],
    [
      'publish a declared name',
      await answer(async () => (await project.publish(at(project, '.claude/skills/p/a.md'), bytes)).outcome),
    ],
    ['publish outside the set', await answer(() => project.publish(at(project, 'x.md'), bytes))],
    ['fileIdentity outside the set', await answer(() => project.fileIdentity(at(project, 'x.md')))],
    ['stat a name outside the set', await answer(() => project.stat(at(project, 'package.json')))],
    ['stat a declared file', await answer(async () => (await project.stat(at(project, '.mcp.json')))?.kind)],
    [
      'stat a declared folder',
      await answer(async () => (await project.stat(at(project, '.claude/skills/x')))?.kind ?? 'none'),
    ],
    [
      'lstat a folder above a grant',
      await answer(async () => (await project.lstat(at(project, '.claude/skills')))?.kind ?? 'none'),
    ],
    ['lstat outside the set', await answer(() => project.lstat(at(project, 'src')))],
    [
      'list a grant folder',
      await answer(async () => [...(await project.list(at(project, '.agents/skills/y')))].sort()),
    ],
    ['list above a grant', await answer(() => project.list(at(project, '.claude/skills')))],
    ['entries above a grant', await answer(() => project.entries(at(project, '.claude')))],
    ['list the project folder', await answer(() => project.list(at(project, '')))],
    ['makeDirectory a grant folder', await answer(() => project.makeDirectory(at(project, '.claude/skills/m/sub')))],
    ['makeDirectory outside the set', await answer(() => project.makeDirectory(at(project, '.claude/other')))],
    ['makeDirectory the MCP name', await answer(() => project.makeDirectory(at(project, '.mcp.json')))],
    ['setMode a declared name', await answer(() => project.setMode(at(project, '.mcp.json'), 0o644))],
    ['its mode', await answer(async () => (await project.stat(at(project, '.mcp.json')))?.mode)],
    ['setMode outside the set', await answer(() => project.setMode(at(project, 'package.json'), 0o644))],
    ['setMode out of range', await answer(() => project.setMode(at(project, '.mcp.json'), 0o10000))],
    [
      'linkTo in a project folder',
      await answer(() =>
        project.linkTo(at(project, '.claude/skills/x/l'), { root: project, path: at(project, '.mcp.json') }),
      ),
    ],
    [
      'rename in a project folder',
      await answer(() => project.rename(at(project, '.claude/skills/x'), at(project, '.claude/skills/z'))),
    ],
    ['unlink in a project folder', await answer(() => project.unlink(at(project, '.claude/skills/x/l')))],
    ['pin a project folder', await answer(() => project.pin(at(project, '.claude/skills/x')))],
    // BG-014 m2: the declared set gates `ensurePrivateDirectory` on both hosts (a name above a grant is only made)
    [
      'ensurePrivateDirectory outside the set',
      await answer(() => project.ensurePrivateDirectory(at(project, '.git/hooks-x'))),
    ],
    ['ensurePrivateDirectory a name outside', await answer(() => project.ensurePrivateDirectory(at(project, 'other')))],
    [
      'ensurePrivateDirectory above a grant',
      await answer(() => project.ensurePrivateDirectory(at(project, '.claude/skills/pe'))),
    ],
    ['remove outside the set', await answer(() => project.remove(at(project, 'package.json')))],
    ['remove above a grant', await answer(() => project.remove(at(project, '.claude/skills')))],
    [
      'remove a non-empty grant folder onlyIfEmpty',
      await answer(() => project.remove(at(project, '.claude/skills/x'), { onlyIfEmpty: true })),
    ],
    ['remove a grant folder', await answer(() => project.remove(at(project, '.claude/skills/m')))],
    [
      'the removed folder is gone',
      await answer(async () => (await project.stat(at(project, '.claude/skills/m'))) ?? 'none'),
    ],
    ['remove a declared file', await answer(() => project.remove(at(project, '.mcp.json')))],
    ['the removed file is gone', await answer(async () => (await project.stat(at(project, '.mcp.json'))) ?? 'none')],
    ['resolve .. up and out', { ...resolveAnswer(project, '.claude/skills/x/../../../escape') }],
    ['resolve .. back into the set', { ...resolveAnswer(project, '.claude/skills/x/../../skills/x/a') }],
    ['resolve an absolute path', { ...resolveAnswer(project, '/etc/passwd') }],
    ['resolve an absolute path inside the folder', { ...resolveAnswer(project, `${places.proj}/.mcp.json`) }],
    ['resolve NUL', { ...resolveAnswer(project, '.mcp.json\0') }],
    [
      'write a forged .. path',
      await answer(() => project.writeText(`${places.proj}/.mcp.json/../.mcp.json` as FencedPath, 'x')),
    ],
    ['write a forged outside path', await answer(() => project.writeText('/etc/passwd' as FencedPath, 'x'))],
    ['write a forged NUL path', await answer(() => project.writeText(`${places.proj}/.mcp.json\0` as FencedPath, 'x'))],
    ['write the project folder itself', await answer(() => project.writeText(at(project, ''), 'x'))],
    ['a second folder: its own file', await answer(() => second.writeText(at(second, '.mcp.json'), 'B'))],
    [
      'a second folder: the first one’s path',
      await answer(() => second.writeText(at(project, '.claude/skills/x/SKILL.md'), 'B')),
    ],
    [
      'a second folder: the first one’s file',
      await answer(() => second.readText(at(project, '.claude/skills/x/SKILL.md'))),
    ],
    [
      'inside the fence: write',
      await answer(() => fenced.writeText(`${places.home}/state/proj/.mcp.json` as FencedPath, 'x')),
    ],
    ['inside the fence: resolve', { ...resolveAnswer(fenced, '.mcp.json') }],
    ...(await modeCases()),
    ...(await copyCases()),
    ...(await plantedCases()),
    ['an invalid scope: relative', await scopeAnswer(mcp, 'proj')],
    ['an invalid scope: the root', await scopeAnswer(mcp, '/')],
    ['an invalid scope: a trailing slash', await scopeAnswer(mcp, `${places.proj}/`)],
    ['an invalid scope: ..', await scopeAnswer(mcp, `${places.proj}/../x`)],
    ['an invalid scope: none', await scopeAnswer(mcp, undefined)],
    ['a plugin without the root', await answer(() => stranger.roots.root('project-files', { subfolder: places.proj }))],
    ['kind of the handle', { ok: [project.name, project.internal] }],
  ];
}

/** What a handle scoped to `subfolder` makes of a plain write: it resolves nothing when the scope is not one folder. */
async function scopeAnswer(kernel: KernelPorts, subfolder: string | undefined): Promise<Answer> {
  const root = kernel.roots.root('project-files', subfolder === undefined ? undefined : { subfolder });
  const found = root.resolve('.mcp.json');
  if (found.ok) return { ok: 'resolved' };
  return await answer(() => root.writeText('/x/.mcp.json' as FencedPath, 'x'));
}

async function onTestingHost() {
  const seen: Seen = {};
  const owner = '/home/owner';
  const host = await testHost({ plugins: halves(seen), ownerHome: owner, fenceHome: `${owner}/.test-home` });
  try {
    return await cases(seen, {
      proj: `${owner}/proj`,
      other: `${owner}/proj2`,
      home: `${owner}/.test-home`,
      plantLink: async relative => host.putRootLink('project-files', `${owner}/proj/${relative}`),
      plantHardLink: async (relative, text) => host.putRootHardLink('project-files', `${owner}/proj/${relative}`, text),
      plantSource: async () => host.putRoot('downloads', 'pack/SKILL.md', '# pack'),
    });
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/project-files-parity-`));
  parents.push(parent);
  const owner = `${parent}/owner`;
  const home = `${owner}/.test-home`;
  const proj = `${owner}/proj`;
  for (const folder of [proj, `${owner}/proj2`, `${owner}/outside`])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return await cases(seen, {
      proj,
      other: `${owner}/proj2`,
      home,
      plantLink: async relative => {
        await rm(`${proj}/${relative}`, { recursive: true, force: true });
        await mkdir(dirname(`${proj}/${relative}`), { recursive: true });
        await symlink(`${owner}/outside`, `${proj}/${relative}`);
      },
      plantHardLink: async (relative, text) => {
        const elsewhere = `${owner}/outside/${relative.replaceAll('/', '_')}`;
        await mkdir(dirname(`${proj}/${relative}`), { recursive: true });
        await writeFile(elsewhere, text);
        await link(elsewhere, `${proj}/${relative}`);
      },
      plantSource: async () => {
        await mkdir(`${home}/state/mcp/downloads/pack`, { recursive: true });
        await writeFile(`${home}/state/mcp/downloads/pack/SKILL.md`, '# pack');
      },
    });
  } finally {
    await outcome.host.stop();
  }
}

test('S179 project-files parity: every case is answered alike on the testing host and the real host', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing).toEqual(real);
  // and what both answer is the rule, so parity is not two hosts agreeing on a wrong answer
  const byCase = Object.fromEntries(real);
  expect(byCase['write .mcp.json']).toEqual({ ok: null });
  expect(byCase['write .claude/skills/x/SKILL.md']).toEqual({ ok: null });
  expect(byCase['write .claude/other']).toEqual({ refused: 'not_declared' });
  expect(byCase['write .claude/skills/x']).toEqual({ refused: 'not_declared' });
  expect(byCase['write .CLAUDE/skills/x/a']).toEqual({ refused: 'not_declared' });
  expect(byCase['write through a link at the leaf']).toEqual({ refused: 'link_escape' });
  expect(byCase['write below a link at a folder level']).toEqual({ refused: 'link_escape' });
  expect(byCase['write a hard-linked file']).toEqual({ refused: 'hard_link' });
  expect(byCase['read a hard-linked file']).toEqual({ refused: 'hard_link' });
  expect(byCase['resolve .. back into the set']).toEqual({ refused: 'outside' });
  expect(byCase['resolve an absolute path inside the folder']).toEqual({ refused: 'outside' });
  expect(byCase['write a forged .. path']).toEqual({ refused: 'outside' });
  expect(byCase['inside the fence: write']).toEqual({ refused: 'fenced' });
  expect(byCase['a second folder: the first one’s path']).toEqual({ refused: 'outside' });
  expect(byCase['linkTo in a project folder']).toEqual({ refused: 'read_only' });
  expect(byCase['rename in a project folder']).toEqual({ refused: 'read_only' });
  expect(byCase['unlink in a project folder']).toEqual({ refused: 'read_only' });
  expect(byCase['pin a project folder']).toEqual({ refused: 'not_declared' });
  expect(byCase['ensurePrivateDirectory outside the set']).toEqual({ refused: 'not_declared' });
  expect(byCase['ensurePrivateDirectory a name outside']).toEqual({ refused: 'not_declared' });
  expect(byCase['ensurePrivateDirectory above a grant']).toEqual({ ok: null });
  expect(byCase['a plugin without the root']).toEqual({ refused: 'not_declared' });
  expect(byCase['kind of the handle']).toEqual({ ok: ['project-files', false] });
  expect(byCase['remove a non-empty grant folder onlyIfEmpty']).toEqual({ refused: 'not_empty' });
  // replaceExisting keeps the mode of the file it replaces, and a given mode wins (m1)
  expect(byCase['mode after the write']).toEqual({ ok: 0o755 });
  expect(byCase['mode kept by replaceExisting']).toEqual({ ok: 0o755 });
  expect(byCase['mode set by replaceExisting']).toEqual({ ok: 0o640 });
  // copyTree: a copy lands, and no link is made into a project folder or from one (H1), the source is gated too (Md2)
  expect(byCase['copy a downloads folder into a grant']).toEqual({ ok: null });
  expect(byCase['the copy landed']).toEqual({ ok: '# pack' });
  expect(byCase['copy into a folder above a grant']).toEqual({ refused: 'not_declared' });
  expect(byCase['copy into a name outside the set']).toEqual({ refused: 'not_declared' });
  expect(byCase['copyTree link into a grant']).toEqual({ refused: 'read_only' });
  expect(byCase['copyTree link above a grant']).toEqual({ refused: 'not_declared' });
  expect(byCase['copyTree link from a project folder into a project folder']).toEqual({ refused: 'read_only' });
  expect(byCase['copy FROM a folder above a grant into a project folder']).toEqual({ refused: 'not_declared' });
  expect(byCase['copy a project folder into downloads']).toEqual({ ok: null });
  expect(byCase['the project copy landed']).toEqual({ ok: '# pack' });
  expect(byCase['copy FROM a folder above a grant']).toEqual({ refused: 'not_declared' });
  expect(byCase['copy FROM the skills folder above a grant']).toEqual({ refused: 'not_declared' });
  expect(byCase['copy FROM a name outside the set']).toEqual({ refused: 'not_declared' });
  // downloads takes no link (BG-004): the destination is judged before the project source is held against a link
  expect(byCase['copyTree link FROM a project folder into downloads']).toEqual({ refused: 'read_only' });
  expect(byCase['copyTree link FROM a folder above a grant']).toEqual({ refused: 'not_declared' });
  expect(byCase['a stranger handle as the source']).toEqual({ refused: 'not_declared' });
  // remove never follows the leaf: a link at a grant is unlinked, a link above the name is refused (M1)
  expect(byCase['remove a link at a grant']).toEqual({ ok: null });
  expect(byCase['the removed link is gone']).toEqual({ ok: 'none' });
  expect(byCase['remove below a link at a folder level']).toEqual({ refused: 'link_escape' });
  expect(byCase['remove a link at the leaf of a file name']).toEqual({ ok: null });
});
