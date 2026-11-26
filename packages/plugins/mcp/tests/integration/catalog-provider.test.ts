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

// ── the file as the root reports it, when the root misbehaves ─────────────────────────────────────────────────────────

describe('the .mcp.json of a project, when the root cannot give a straight answer', () => {
  /** A root handle that answers as told: the real root is proved above, this is for what a disk does when it fails. */
  function stub(over: Partial<Record<'resolve' | 'lstat' | 'readBytes' | 'writeBytes', unknown>> = {}) {
    const handle = {
      resolve: () => ({ ok: true as const, value: '/project/.mcp.json' }),
      lstat: async () => ({ kind: 'file' as const, size: 3 }),
      readBytes: async () => new TextEncoder().encode('abc'),
      writeBytes: async () => undefined,
      ...over,
    };
    return new CatalogMcpProjectFile(
      async () => ['/project'],
      () => handle as never,
    );
  }
  const FILE = '/project/.mcp.json';
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CatalogItemRefusal);
    return (error as CatalogItemRefusal).message;
  };

  test('refuses a file larger than 1 MiB without reading it', async () => {
    const w = await world();
    await writeFile(w.file, Buffer.alloc(1024 * 1024 + 1, 'a'));
    expect(await refusal(w.files.read(w.file))).toBe(
      `${w.file} is larger than 1 MiB, so Ferretry will not read or replace it.`,
    );
    await writeFile(w.file, Buffer.alloc(1024 * 1024, 'a'));
    expect((await w.files.read(w.file)).text).toHaveLength(1024 * 1024);
  });

  test('says the name cannot be reached when the root will not resolve it', async () => {
    const files = stub({ resolve: () => ({ ok: false as const, reason: 'outside' }) });
    expect(await refusal(files.read(FILE))).toBe(`${FILE} cannot be reached, so it will not be read or replaced.`);
  });

  test('refuses a file the root cannot look at, or cannot read', async () => {
    const unlooked = stub({
      lstat: async () => {
        throw new Error('not_a_file');
      },
    });
    const message = `${FILE} is a link, or not a regular file, so Ferretry will not read or replace it.`;
    expect(await refusal(unlooked.read(FILE))).toBe(message);
    const unread = stub({
      readBytes: async () => {
        throw new Error('changed');
      },
    });
    expect(await refusal(unread.read(FILE))).toBe(message);
  });

  test('says why a write failed, in the disk’s own words, and “refused” when it gave none', async () => {
    const gone = { lstat: async () => undefined };
    const worded = stub({
      ...gone,
      writeBytes: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await refusal(worded.replace(FILE, '{}', null))).toBe(
      `${FILE} could not be written (EACCES: permission denied).`,
    );
    const wordless = stub({
      ...gone,
      writeBytes: async () => {
        throw 'no';
      },
    });
    expect(await refusal(wordless.replace(FILE, '{}', null))).toBe(`${FILE} could not be written (refused).`);
  });

  test('reads a failed first write as someone else having created the file first', async () => {
    let created = false;
    const raced = stub({
      lstat: async () => (created ? { kind: 'file' as const, size: 1 } : undefined),
      writeBytes: async () => {
        created = true;
        throw new Error('exists');
      },
    });
    await expect(raced.replace(FILE, '{}', null)).rejects.toBeInstanceOf(McpProjectFileChanged);
  });

  test('keeps a failed replace of an existing file a refusal, never a change', async () => {
    const files = stub({
      writeBytes: async () => {
        throw new Error('disk full');
      },
    });
    const { etag } = await files.read(FILE);
    expect(await refusal(files.replace(FILE, '{}', etag))).toBe(`${FILE} could not be written (disk full).`);
  });
});

describe('the runtimes a catalog MCP server can be installed into', () => {
  test('names every runtime by its harness plugin KEY, so a third plugin registered under `claude` is never Claude Code', async () => {
    const runtime = mcpCatalogRuntime({
      runtimes: () =>
        ({
          list: async () => [
            { id: 'a', harness: 'claude-code', profile: 'work' },
            { id: 'b', harness: 'codex', profile: 'work' },
            { id: 'c', harness: 'claude', profile: 'work' },
            { id: 'd', harness: 'fake-third', profile: 'work' },
          ],
        }) as never,
      items: () => new Map(),
    } as never);
    const listed = await runtime.runtimes();
    expect(listed.runtimes.map(each => `${each.id}:${each.harness}`)).toEqual([
      'a:claude-code',
      'b:codex',
      'c:claude',
      'd:fake-third',
    ]);
  });
});
