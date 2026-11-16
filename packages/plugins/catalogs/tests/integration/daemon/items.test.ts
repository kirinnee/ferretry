/**
 * How Catalogs reaches the items other plugins own: Skills' and MCP's providers are asked again on EVERY call, so an
 * owner that is off or damaged can never leave a usable cached writer behind, and a kind nobody offers is a 503 with a
 * fixed sentence. The providers are the other plugins' own hooks, stood in by recorders that say which call reached them.
 */
import { describe, expect, it } from 'bun:test';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import { CatalogItems } from '../../../contract/items/index.ts';
import { itemProviders } from '../../../daemon/adapters/items.ts';

type Call = readonly [string, ...unknown[]];

/** One recorder per provider: every method records its name and arguments and answers a marker naming it. */
function recorder(kind: 'skill' | 'mcp', calls: Call[], roots: readonly string[]) {
  const answer =
    (name: string, value: unknown = `${kind}:${name}`) =>
    async (...args: unknown[]) => {
      calls.push([`${kind}.${name}`, ...args]);
      return value;
    };
  return {
    kind,
    sources: answer('sources', [{ name: `${kind}-source` }]),
    projectRoots: async () => roots,
    runtime: {
      runtimes: answer('runtimes', [{ id: `${kind}-runtime` }]),
      profiles: answer('profiles', [{ id: `${kind}-profile` }]),
      storedComponent: answer('storedComponent'),
      propose: answer('propose', { id: `${kind}-proposal` }),
      apply: answer('apply'),
      installCatalogItem: answer('installCatalogItem'),
    },
    tree: { list: answer('tree.list'), read: answer('tree.read') },
    project: {
      inspect: answer('project.inspect'),
      read: answer('project.read'),
      apply: answer('project.apply'),
      replace: answer('project.replace'),
    },
    assets: { inspect: answer('assets.inspect'), read: answer('assets.read'), remove: answer('assets.remove') },
  };
}

type Ask = (...args: unknown[]) => Promise<unknown>;

/** The adapter as the tests call it: every call takes whatever arguments a case wants to see passed through. */
interface Loose {
  readonly skills: { list: Ask };
  readonly mcp: { servers: Ask };
  readonly tree: Record<'list' | 'read', Ask>;
  readonly skillFiles: Record<'inspect' | 'read' | 'apply', Ask>;
  readonly assets: Record<'inspect' | 'read' | 'remove', Ask>;
  readonly mcpFiles: Record<'read' | 'replace', Ask>;
  readonly runtime: {
    runtimes: Ask;
    profiles: Ask;
    storedComponent: Ask;
    propose: (change: unknown) => Promise<{ id: string }>;
    apply: Ask;
    installCatalogItem: Ask;
  };
  projectRoots: Ask;
}

function world(options: { skill?: boolean; mcp?: boolean; projects?: ProjectsApi | undefined } = {}) {
  const calls: Call[] = [];
  const skill = recorder('skill', calls, ['/work/skills']);
  const mcp = recorder('mcp', calls, ['/work/mcp']);
  const hooks = {
    provider: (hook: unknown, kind: 'skill' | 'mcp') =>
      hook === CatalogItems && (kind === 'skill' ? options.skill !== false : options.mcp !== false)
        ? kind === 'skill'
          ? skill
          : mcp
        : 'unavailable',
  };
  const handle = { current: () => options.projects } as unknown as UsesHandle<ProjectsApi>;
  return { calls, items: itemProviders(hooks as never, handle) as unknown as Loose };
}

const unavailable = (what: string) => ({
  status: 503,
  code: 'catalog_kind_unavailable',
  message: expect.stringContaining(what),
});

describe('the items Skills and MCP offer, when both are on', () => {
  it('lists each kind’s sources from its own provider', async () => {
    const { items } = world();

    expect(await items.skills.list()).toEqual([{ name: 'skill-source' }]);
    expect(await items.mcp.servers()).toEqual([{ name: 'mcp-source' }]);
  });

  it('reads a skill’s tree, its project files and its runtime assets from Skills, and a project’s MCP file from MCP', async () => {
    const { items, calls } = world();

    await items.tree.list('a');
    await items.tree.read('b');
    await items.skillFiles.inspect('c');
    await items.skillFiles.read('d');
    await items.skillFiles.apply('e');
    await items.assets.inspect('f');
    await items.assets.read('g');
    await items.assets.remove('h');
    await items.mcpFiles.read('i');
    await items.mcpFiles.replace('j');

    expect(calls).toEqual([
      ['skill.tree.list', 'a'],
      ['skill.tree.read', 'b'],
      ['skill.project.inspect', 'c'],
      ['skill.project.read', 'd'],
      ['skill.project.apply', 'e'],
      ['skill.assets.inspect', 'f'],
      ['skill.assets.read', 'g'],
      ['skill.assets.remove', 'h'],
      ['mcp.project.read', 'i'],
      ['mcp.project.replace', 'j'],
    ]);
  });

  it('asks Skills for the runtimes and profiles an item may land in, and the right provider for a stored component', async () => {
    const { items, calls } = world();

    expect(await items.runtime.runtimes()).toEqual([{ id: 'skill-runtime' }]);
    expect(await items.runtime.profiles()).toEqual([{ id: 'skill-profile' }]);
    await items.runtime.storedComponent('skills', 'one');
    await items.runtime.storedComponent('mcp', 'two');

    expect(calls).toEqual([
      ['skill.runtimes'],
      ['skill.profiles'],
      ['skill.storedComponent', 'one'],
      ['mcp.storedComponent', 'two'],
    ]);
  });

  it('holds a proposal until it is applied, applies it once through the provider that made it, and refuses it after', async () => {
    const { items, calls } = world();

    const skill = await items.runtime.propose({ componentKind: 'skills', name: 'x' } as never);
    const mcp = await items.runtime.propose({ componentKind: 'mcp', name: 'y' } as never);

    expect(skill).toEqual({ id: 'skills:skill-proposal' });
    expect(mcp).toEqual({ id: 'mcp:mcp-proposal' });
    expect(calls).toEqual([
      ['skill.propose', { name: 'x' }],
      ['mcp.propose', { name: 'y' }],
    ]);

    await items.runtime.apply(skill.id, 'governance' as never, 'fresh' as never);
    expect(calls.at(-1)).toEqual(['skill.apply', 'skill-proposal', 'governance', 'fresh']);
    await expect(items.runtime.apply(skill.id, 'governance' as never, 'fresh' as never)).rejects.toMatchObject({
      status: 409,
      code: 'catalog_install_conflict',
    });
    await expect(items.runtime.apply('never-proposed', 'governance' as never, 'fresh' as never)).rejects.toMatchObject({
      status: 409,
    });
    await items.runtime.apply(mcp.id, 'governance' as never, 'fresh' as never);
    expect(calls.at(-1)).toEqual(['mcp.apply', 'mcp-proposal', 'governance', 'fresh']);
  });

  it('installs an item through MCP when it is an MCP server and through Skills otherwise', async () => {
    const { items, calls } = world();

    await items.runtime.installCatalogItem({ component: { kind: 'mcp' } } as never, 'g' as never);
    await items.runtime.installCatalogItem({ component: { kind: 'skills' } } as never, 'g' as never);

    expect(calls.map(call => call[0])).toEqual(['mcp.installCatalogItem', 'skill.installCatalogItem']);
  });

  it('names every folder an item may be installed into: the providers’ and every registered project’s, once each', async () => {
    const projects = fakeProjects();
    await projects.register({ kind: 'existing-folder', path: '/work/app' });
    await projects.register({ kind: 'existing-folder', path: '/work/skills' });

    expect(await world({ projects }).items.projectRoots()).toEqual(['/work/skills', '/work/mcp', '/work/app']);
    expect(await world({ projects: undefined }).items.projectRoots()).toEqual(['/work/skills', '/work/mcp']);
  });
});

describe('the items when an owner is off', () => {
  it('refuses with a fixed 503 sentence what Skills alone can do while Skills is off', async () => {
    const { items } = world({ skill: false });

    await expect(items.skills.list()).rejects.toMatchObject(unavailable('Skills is not available'));
    await expect(items.tree.list('a')).rejects.toMatchObject({ status: 503 });
    await expect(items.skillFiles.read('a')).rejects.toMatchObject({ status: 503 });
    await expect(items.assets.read('a')).rejects.toMatchObject({ status: 503 });
    await expect(items.runtime.storedComponent('skills', 'a')).rejects.toMatchObject({ status: 503 });
    await expect(
      items.runtime.installCatalogItem({ component: { kind: 'skills' } } as never, 'g' as never),
    ).rejects.toMatchObject({
      status: 503,
    });
  });

  it('still reads the runtimes and the roots through MCP while Skills is off', async () => {
    const { items } = world({ skill: false });

    expect(await items.runtime.runtimes()).toEqual([{ id: 'mcp-runtime' }]);
    expect(await items.projectRoots()).toEqual(['/work/mcp']);
  });

  it('refuses with a fixed 503 sentence what MCP alone can do while MCP is off', async () => {
    const { items } = world({ mcp: false });

    await expect(items.mcp.servers()).rejects.toMatchObject(unavailable('MCP is not available'));
    await expect(items.mcpFiles.read('a')).rejects.toMatchObject({ status: 503 });
    await expect(items.runtime.propose({ componentKind: 'mcp', name: 'y' } as never)).rejects.toMatchObject({
      status: 503,
    });
    expect(await items.projectRoots()).toEqual(['/work/skills']);
  });

  it('reads no targets and no roots when neither is on', async () => {
    const { items } = world({ skill: false, mcp: false });

    await expect(items.runtime.runtimes()).rejects.toMatchObject(
      unavailable('No item provider can read runtime targets'),
    );
    await expect(items.runtime.profiles()).rejects.toMatchObject({ status: 503 });
    await expect(items.projectRoots()).rejects.toMatchObject(unavailable('No item provider can read project targets'));
  });

  it('treats a provider of the wrong kind as no provider at all', async () => {
    const calls: Call[] = [];
    const wrong = recorder('mcp', calls, []);
    const items = itemProviders(
      { provider: (hook: unknown) => (hook === CatalogItems ? wrong : 'unavailable') } as never,
      { current: () => undefined } as never,
    ) as unknown as Loose;

    await expect(items.skills.list()).rejects.toMatchObject({ status: 503 });
    expect(await items.mcp.servers()).toEqual([{ name: 'mcp-source' }]);
  });
});
