import { expect, test } from 'bun:test';
import type { KernelPorts, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../host/roots.ts';
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
