/**
 * The testing host's `project-files` root refuses EVERY write `no_descriptor_reach` when the host reaches a held folder
 * by neither a descriptor path nor the C library's calls (S179), as the real host does (it never falls back to a path),
 * not only a remove. Reads still work. A plugin's test that sets `noDescriptorReach` therefore meets production.
 */
import { expect, test } from 'bun:test';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { RootError } from '../../../host/roots.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const PROJECT = '/work/proj';

async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

async function rootOf(noDescriptorReach: boolean): Promise<{ root: RootHandle; stop: () => Promise<void> }> {
  let seen: KernelPorts | undefined;
  const host = await testHost({
    ...(noDescriptorReach ? { noDescriptorReach: true as const } : {}),
    plugins: [
      implementDaemon(
        definePlugin({
          id: 'mcp',
          title: 'MCP',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['project-files', 'downloads'], projectFiles: ['.mcp.json', '.claude/skills/*/**'] },
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
  return {
    root: seen.roots.root('project-files', { subfolder: PROJECT }),
    stop: async () => await host.stop(),
  };
}

const at = (root: RootHandle, path: string) => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

test('S179 the testing twin refuses every project-files write no_descriptor_reach, as production does', async () => {
  const world = await rootOf(true);
  try {
    const { root } = world;
    const refusals = {
      writeText: await refusalOf(() => root.writeText(at(root, '.mcp.json'), 'FIXTURE')),
      writeBytes: await refusalOf(() => root.writeBytes(at(root, '.mcp.json'), new Uint8Array([1]))),
      publish: await refusalOf(() => root.publish(at(root, '.mcp.json'), new Uint8Array([1]))),
      makeDirectory: await refusalOf(() => root.makeDirectory(at(root, '.claude/skills/new'))),
      ensurePrivateDirectory: await refusalOf(() => root.ensurePrivateDirectory(at(root, '.claude/skills/new'))),
    };
    expect(refusals).toEqual({
      writeText: 'no_descriptor_reach',
      writeBytes: 'no_descriptor_reach',
      publish: 'no_descriptor_reach',
      makeDirectory: 'no_descriptor_reach',
      ensurePrivateDirectory: 'no_descriptor_reach',
    });
    // nothing was written
    expect(await root.lstat(at(root, '.mcp.json'))).toBeUndefined();
    // a name outside the declared set is still refused for that reason first
    expect(await refusalOf(() => root.writeText(at(root, 'other.txt'), 'FIXTURE'))).toBe('not_declared');
  } finally {
    await world.stop();
  }
});

// followups row 54 (kcb-kb-r2 N3): copyTree is a write too, and, as production, it judges the SOURCE handle (`not_declared`)
// before it meets the host's missing reach: both refuse, but the sentence a plugin's test sees is production's.
test('S179 the testing twin refuses a project-files copyTree no_descriptor_reach, after the source handle is judged', async () => {
  const world = await rootOf(true);
  try {
    const { root } = world;
    // a declared source (another handle of the same plugin) with a destination the host cannot reach
    expect(await refusalOf(() => root.copyTree(root, at(root, '.claude/skills/a'), at(root, '.claude/skills/b')))).toBe(
      'no_descriptor_reach',
    );
    // a source that is no handle of this plugin is `not_declared` first, whatever the host can reach
    const foreign = {} as RootHandle;
    expect(
      await refusalOf(() => root.copyTree(foreign, at(root, '.claude/skills/a'), at(root, '.claude/skills/b'))),
    ).toBe('not_declared');
    // a link into a project folder is refused `read_only` before the reach, as `linkTo` refuses it
    expect(
      await refusalOf(() =>
        root.copyTree(root, at(root, '.claude/skills/a'), at(root, '.claude/skills/b'), { link: true }),
      ),
    ).toBe('read_only');
    // nothing was written
    expect(await root.lstat(at(root, '.claude/skills/b'))).toBeUndefined();
  } finally {
    await world.stop();
  }
});

test('S179 the testing twin with descriptor reach (the default) writes', async () => {
  const world = await rootOf(false);
  try {
    await world.root.writeText(at(world.root, '.mcp.json'), 'FIXTURE');
    expect(await world.root.readText(at(world.root, '.mcp.json'))).toBe('FIXTURE');
  } finally {
    await world.stop();
  }
});
