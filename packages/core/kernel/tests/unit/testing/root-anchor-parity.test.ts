import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts, RootName, RootsPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * The testing host judges a `within` anchor with the rule production reads (`anchorWalk`, `takesAnchor`): the same
 * scopes name a folder on both and the same scopes name none, so a plugin's unit test meets what production does. The
 * lstat walk itself needs a real disk and is production's alone (`tests/unit/host/root-anchor-links.test.ts`).
 */
const FOLDER = '/work/proj/.claude/skills';
const CASES: readonly { readonly name: RootName; readonly subfolder?: string; readonly within?: string }[] = [
  { name: 'imports', subfolder: FOLDER },
  { name: 'imports', subfolder: FOLDER, within: '/work/proj' },
  { name: 'imports', subfolder: FOLDER, within: '/work/proj/.claude' },
  { name: 'imports', subfolder: FOLDER, within: FOLDER },
  { name: 'imports', subfolder: FOLDER, within: '/work/proj/.claude2' },
  { name: 'imports', subfolder: FOLDER, within: '/work/proj/.claud' },
  { name: 'imports', subfolder: FOLDER, within: `${FOLDER}/review` },
  { name: 'imports', subfolder: FOLDER, within: 'proj' },
  { name: 'imports', subfolder: FOLDER, within: '/' },
  { name: 'imports', subfolder: FOLDER, within: '/work/../work/proj' },
  // The spellings production's `absolute()` normalises before it walks: the twin names a folder for each, too.
  { name: 'imports', subfolder: `${FOLDER}/`, within: '/work/proj' },
  { name: 'imports', subfolder: '/work/proj//.claude/skills', within: '/work/proj' },
  { name: 'imports', subfolder: '/work/proj/./.claude/skills', within: '/work/proj' },
  { name: 'imports', subfolder: '/work/proj/x/../.claude/skills', within: '/work/proj' },
  { name: 'harness-history', subfolder: `${FOLDER}/`, within: '/work/proj' },
  { name: 'harness-history', subfolder: '/work/proj/./.claude/skills', within: '/work/proj' },
  { name: 'imports', subfolder: `${FOLDER}/`, within: '/work/proj/' },
  { name: 'imports', subfolder: '/work/proj/x/../.claude/skills', within: '/work/proj/.claude' },
  { name: 'imports', subfolder: '/work/proj/x/../.claude/skills', within: '/work/other' },
  { name: 'imports', within: '/work/proj' },
  { name: 'harness-history', subfolder: FOLDER, within: '/work/proj' },
  { name: 'harness-history', subfolder: FOLDER, within: '/work/other' },
  { name: 'downloads', within: '/work/proj' },
];

test('the testing host names a folder for an anchored scope exactly when the real roots port does', async () => {
  let seen: KernelPorts | undefined;
  const half = implementDaemon(
    definePlugin({
      id: 'skills',
      title: 'Skills',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['imports', 'harness-history', 'downloads'] },
    }),
    {
      build: ({ kernel }) => {
        seen = kernel;
        return {};
      },
    },
  );
  const host = await testHost({ plugins: [half] });
  if (seen === undefined) throw new Error('the half was not built');
  const real = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: '/nonexistent/home', plugin: 'skills', worktrees: '/nonexistent/home-worktrees' },
    ['imports', 'harness-history', 'downloads'],
    () => undefined,
  );
  for (const { name, ...scope } of CASES) {
    const production = real.root(name, scope).resolve('');
    const twin = seen.roots.root(name, scope).resolve('');
    expect({ name, scope, named: twin.ok }).toEqual({ name, scope, named: production.ok });
  }
  await host.stop();
});

/**
 * The `project-files` rule BELOW the anchor (S179): the anchor itself may be a link, a link under it is `link_escape`,
 * and without an anchor the folder must be its own real path. The real host judges it on a real disk; the testing host
 * is told which folders are links (`linkedProjectFolders`) and judges the same `spellingHolds`.
 */
test('S179 the testing host refuses a project folder whose realpath is not its spelling below the anchor exactly when the real roots port does', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-anchor-parity-`));
  try {
    const real = `${parent}/real`;
    await mkdir(`${real}/proj`, { recursive: true });
    await mkdir(`${parent}/ws`, { recursive: true });
    await mkdir(`${parent}/home/state`, { recursive: true, mode: 0o700 });
    await symlink(real, `${parent}/ws/link`);
    await symlink(`${real}/proj`, `${parent}/proj-link`);
    const links = new Map([
      [`${parent}/ws/link`, real],
      [`${parent}/proj-link`, `${real}/proj`],
    ]);
    const cases: readonly { readonly subfolder: string; readonly within?: string }[] = [
      // a plain folder: no anchor, itself as anchor, an ancestor as anchor
      { subfolder: `${real}/proj` },
      { subfolder: `${real}/proj`, within: `${real}/proj` },
      { subfolder: `${real}/proj`, within: real },
      // the folder is a link: refused with no anchor, allowed as its own anchor (the anchor may be a link)
      { subfolder: `${parent}/proj-link` },
      { subfolder: `${parent}/proj-link`, within: `${parent}/proj-link` },
      // a link ABOVE the anchor is allowed, a link BELOW it is refused
      { subfolder: `${parent}/ws/link/proj`, within: `${parent}/ws/link` },
      { subfolder: `${parent}/ws/link/proj`, within: `${parent}/ws` },
      { subfolder: `${parent}/ws/link/proj`, within: `${parent}/ws/link/proj` },
      { subfolder: `${parent}/ws/link/proj` },
    ];
    let seen: KernelPorts | undefined;
    const host = await testHost({
      linkedProjectFolders: links,
      plugins: [
        implementDaemon(
          definePlugin({
            id: 'mcp',
            title: 'MCP',
            version: '5.0.0',
            api: 5,
            core: false,
            kinds: [],
            permissions: { roots: ['project-files'], projectFiles: ['.mcp.json'] },
          }),
          {
            build: ({ kernel }) => {
              seen = kernel;
              return {};
            },
          },
        ),
      ],
    });
    if (seen === undefined) throw new Error('the half was not built');
    const production = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: `${parent}/home`, plugin: 'mcp', worktrees: `${parent}/home-worktrees` },
      ['project-files'],
      () => undefined,
      { random: () => 'rnd', projectFiles: ['.mcp.json'] },
    );
    const refusal = async (write: () => Promise<unknown>): Promise<string> => {
      try {
        await write();
        return 'written';
      } catch (error) {
        if (error instanceof RootError) return error.refusal;
        throw error;
      }
    };
    const outcome = async (ports: { readonly roots: RootsPort }, scope: (typeof cases)[number]): Promise<string> => {
      const root = ports.roots.root('project-files', scope);
      const name = root.resolve('.mcp.json');
      return name.ok ? await refusal(() => root.writeText(name.value, '{}')) : name.error;
    };
    for (const scope of cases) {
      const expected = await outcome({ roots: production }, scope);
      expect({ scope, outcome: await outcome(seen, scope) }).toEqual({ scope, outcome: expected });
    }
    // Both hosts agree, and the cases really split: some are allowed and some refused.
    const results = await Promise.all(cases.map(async scope => await outcome({ roots: production }, scope)));
    expect(results).toContain('written');
    expect(results).toContain('link_escape');
    await host.stop();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
