/**
 * What Catalogs asks of the MCP kind (`catalog.items:mcp`): a project's `.mcp.json` through the kernel's REAL
 * `project-files` root on a temp disk (never a real home), and the runtime half with Runtimes and the config writer
 * stood in. The whole path through the composed daemon is proved in the CLI's `catalog-items` integration test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { CatalogItemRefusal, McpProjectFileChanged } from '@ferretry/plugin-catalogs/contract';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import type { McpItem } from '../../contract/index.ts';
import { CatalogMcpProjectFile } from '../../daemon/adapters/catalog-project-file.ts';
import { mcpCatalogRuntime } from '../../daemon/lib/catalog-runtime.ts';
import manifest from '../../manifest.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-catalog-mcp-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(join(home, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(project, { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'mcp', worktrees: `${home}-w` },
    ['project-files'],
    () => undefined,
    { projectFiles: manifest.permissions?.projectFiles ?? [] },
  );
  const files = new CatalogMcpProjectFile(
    async () => [project],
    root => roots.root('project-files', { subfolder: root, within: root }),
  );
  return { parent, project, file: join(project, '.mcp.json'), files };
}

describe('the .mcp.json of a project, as a catalog install reads and replaces it', () => {
  test('reads nothing where there is no file, creates it once, and refuses a second first-add', async () => {
    const w = await world();
    expect(await w.files.read(w.file)).toEqual({ text: null, etag: null });
    const etag = await w.files.replace(w.file, '{"mcpServers":{}}\n', null);
    expect(await readFile(w.file, 'utf8')).toBe('{"mcpServers":{}}\n');
    expect(await w.files.read(w.file)).toEqual({ text: '{"mcpServers":{}}\n', etag });
    await expect(w.files.replace(w.file, '{}', null)).rejects.toBeInstanceOf(McpProjectFileChanged);
  });

  test('replaces only while the file still hashes to what the person reviewed, and keeps its mode', async () => {
    const w = await world();
    await writeFile(w.file, 'one\n');
    await chmod(w.file, 0o640);
    const { etag } = await w.files.read(w.file);
    await writeFile(w.file, 'edited in an editor\n');
    await chmod(w.file, 0o640);
    await expect(w.files.replace(w.file, 'two\n', etag)).rejects.toBeInstanceOf(McpProjectFileChanged);
    expect(await readFile(w.file, 'utf8')).toBe('edited in an editor\n');

    const fresh = (await w.files.read(w.file)).etag;
    await w.files.replace(w.file, 'two\n', fresh);
    expect(await readFile(w.file, 'utf8')).toBe('two\n');
    expect((await stat(w.file)).mode & 0o777).toBe(0o640);
  });

  test('never reads or replaces a link, a folder, or the file of a project nobody registered', async () => {
    const w = await world();
    await writeFile(join(w.parent, 'outside.json'), 'outside');
    await symlink(join(w.parent, 'outside.json'), w.file);
    await expect(w.files.read(w.file)).rejects.toBeInstanceOf(CatalogItemRefusal);
    await expect(w.files.replace(w.file, 'x', null)).rejects.toBeInstanceOf(CatalogItemRefusal);
    expect(await readFile(join(w.parent, 'outside.json'), 'utf8')).toBe('outside');

    const stranger = join(w.parent, 'stranger');
    await mkdir(stranger, { recursive: true });
    await expect(w.files.read(join(stranger, '.mcp.json'))).rejects.toBeInstanceOf(CatalogItemRefusal);
    await expect(w.files.read(join(w.project, 'settings.json'))).rejects.toBeInstanceOf(CatalogItemRefusal);
  });
});

// ── the runtime half ───────────────────────────────────────────────────────────────────────────────────────────────

const PROVENANCE = {
  publisher: 'daemon-1',
  publisherName: 'laptop',
  catalogId: 'cat_x',
  catalogName: 'Team',
  itemId: 'itm_x',
  kind: 'mcp' as const,
  name: 'acme',
  version: 1,
  digest: `sha256:${'0'.repeat(64)}`,
};
const CHANGE = {
  kind: 'catalog.install' as const,
  name: 'acme',
  component: { kind: 'mcp' as const, command: 'npx', args: ['acme-mcp'], env: { TOKEN: '${secret:ACME_TOKEN}' } },
  files: [],
  profile: 'default',
  installedFrom: PROVENANCE as never,
  replace: false,
};
const written: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] } as never;

function runtimeWorld(options: { layer?: 'written' | 'refused' } = {}) {
  const items = new Map<string, McpItem>();
  const calls: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const runtimes = {
    list: async () => [{ id: 'codex-main', harness: 'codex', profile: 'default' }],
    profiles: async () => [{ name: 'default', layers: [], etag: 'p1' }],
    changeProfileLayers: async (change: { kind: string; layer: string }) => {
      calls.push(`${change.kind} ${change.layer}`);
      return options.layer === 'refused'
        ? { kind: 'held' as const, sentence: 'the owner has to confirm' }
        : { kind: 'written' as const, profiles: ['default'] };
    },
  };
  const runtime = mcpCatalogRuntime({
    runtimes: () => runtimes as never,
    items: () => items,
    writeItem: async (name, patch, ifMatch) => {
      calls.push(`write ${name} ${ifMatch ?? 'any'}`);
      patches.push(patch as Record<string, unknown>);
      items.set(name, patch as never);
      return written;
    },
    removeItem: async name => {
      calls.push(`remove ${name}`);
      items.delete(name);
      return written;
    },
  });
  return { runtime, items, calls, patches };
}

describe('installing a catalog MCP server into a runtime', () => {
  test('writes the item and the profile layer; a server reached at a url carries none of a command’s keys', async () => {
    const w = runtimeWorld();
    expect(await w.runtime.runtimes()).toEqual({
      runtimes: [{ id: 'codex-main', name: 'codex-main', profile: 'default', harness: 'codex' }],
    });
    await w.runtime.installCatalogItem(CHANGE, undefined);
    expect(w.calls).toEqual(['write acme absent', 'add mcp/acme']);
    expect(w.patches[0]).toMatchObject({ command: 'npx', args: ['acme-mcp'], env: { TOKEN: '${secret:ACME_TOKEN}' } });

    const replaced = runtimeWorld();
    replaced.items.set('acme', { command: 'npx' } as McpItem);
    await replaced.runtime.installCatalogItem(
      { ...CHANGE, replace: true, component: { kind: 'mcp', url: 'https://acme.example/mcp', auth: 'oauth' } },
      undefined,
    );
    // The keys of the old definition are cleared: a url never keeps a stale command.
    expect(replaced.patches[0]).toMatchObject({
      command: undefined,
      args: undefined,
      env: undefined,
      url: 'https://acme.example/mcp',
    });
    expect(replaced.calls[0]).toBe('write acme any');
  });

  test('takes the item back when the profile change is held, and refuses a name that is not ours to replace', async () => {
    const held = runtimeWorld({ layer: 'refused' });
    await expect(held.runtime.installCatalogItem(CHANGE, undefined)).rejects.toBeInstanceOf(CatalogItemRefusal);
    expect(held.items.has('acme')).toBe(false);

    const taken = runtimeWorld();
    taken.items.set('acme', { command: 'mine' } as McpItem);
    await expect(taken.runtime.installCatalogItem(CHANGE, undefined)).rejects.toMatchObject({
      code: 'catalog_install_conflict',
    });
    expect(taken.calls).toEqual([]);
  });

  test('removal takes the layer out of every profile, then the item', async () => {
    const w = runtimeWorld();
    await w.runtime.installCatalogItem(CHANGE, undefined);
    w.calls.length = 0;
    const proposal = await w.runtime.propose({ kind: 'component.remove', name: 'acme', removeFromProfiles: true });
    await w.runtime.apply(proposal.id, undefined, { claim: () => false, agent: false });
    expect(w.calls).toEqual(['remove-everywhere mcp/acme', 'remove acme']);
  });
});
