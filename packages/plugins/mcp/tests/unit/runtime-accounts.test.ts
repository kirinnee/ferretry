import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type {
  RuntimeHome,
  RuntimeHomeDocument,
  RuntimeHomeReader,
  RuntimeId,
  RuntimeSummary,
} from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { McpInventory } from '../../contract/index.ts';
import mcp from '../../daemon/index.ts';

const A = 'claude-a' as RuntimeId;
const B = 'claude-b' as RuntimeId;
const HOME_A = '/fleet/homes/a';
const HOME_B = '/fleet/homes/b';

const summary = (id: RuntimeId): RuntimeSummary =>
  ({
    id,
    harness: 'claude-code',
    login: 'personal',
    profile: id === A ? 'full' : 'bare',
    agent: false,
    launch: { available: true },
  }) as RuntimeSummary;

const home = (id: string, path: string, runtime: RuntimeId): RuntimeHome => ({
  id,
  harness: 'claude-code',
  runtimes: [runtime],
  home: path,
  wrapper: `${path}/bin/claude`,
});

/** A reader that serves only the documents it is given, and records every request. */
function readerOf(documents: Partial<Record<RuntimeHomeDocument, string>>, asked: string[] = []): RuntimeHomeReader {
  return {
    document: async file => {
      asked.push(file);
      return documents[file] ?? null;
    },
    skills: async () => [],
    skillManifest: async () => undefined,
    skillTree: async () => undefined,
    skillFile: async () => ({ ok: false, reason: 'unreadable' }),
  };
}

const CLAUDE_A = JSON.stringify({
  mcpServers: {
    docs: { type: 'http', url: 'https://docs.example.com/mcp' },
    tool: { command: 'npx', args: ['tool', '--secret-arg'], env: { TOKEN: 'sk-not-a-real-value' } },
    ferretry: { command: 'fy', args: ['mcp', 'serve'] },
  },
  projects: { '/work/app': { mcpServers: { scratch: { command: 'scratch-tool', args: [] } } } },
});
const CLAUDE_B = JSON.stringify({ mcpServers: {} });

const ITEMS = {
  docs: { url: 'https://docs.example.com/mcp' },
  lint: { command: 'npx', args: ['lint-mcp'] },
};

/** Two runtimes: A's profile layers `docs`, B's layers nothing. */
async function world() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('on-a'), folder: '/work/app', runtime: A } as never);
  ferrets.add({ id: ferretId('on-b'), folder: '/work/app', runtime: B } as never);
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([summary(A), summary(B)]);
  const asked: string[] = [];
  runtimes.setHomes([home('a', HOME_A, A), home('b', HOME_B, B)], {
    a: readerOf({ '.claude.json': CLAUDE_A }, asked),
    b: readerOf({ '.claude.json': CLAUDE_B }, asked),
  });
  runtimes.setProfiles(
    [],
    [
      { runtime: A, profile: 'full', mcp: ['docs'], skills: [] },
      { runtime: B, profile: 'bare', mcp: [], skills: [] },
    ],
  );
  const h = await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    uses: { runtimes },
    config: { mcp: ITEMS },
  });
  return { h, runtimes, asked };
}

const as = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;
const view = (inventory: McpInventory) =>
  inventory.servers.map(server => [server.name, server.scope, server.runtimes.map(use => use.runtime)] as const);

describe('MCP accounts and components, by runtime profile', () => {
  test('R-0112 the machine list shows each runtime home once: a component in the runtimes whose profile layers it, a user server beside it, and no args', async () => {
    const { h } = await world();
    const response = await h.request('GET', '/v1/mcp', { as: as('fleet.use') });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const inventory = response.json<McpInventory>();
    const rows = view(inventory);
    // `docs` is a component of runtime A only (A's profile layers it); B's layers do not name it.
    expect(rows).toContainEqual(['docs', 'component', [A]]);
    // `tool` is written in A's home only, and no profile layers it: a user server.
    expect(rows).toContainEqual(['tool', 'user', [A]]);
    // Ferretry's own tools server is listed once per harness, seen by every runtime of it.
    expect(rows).toContainEqual(['ferretry', 'ferretry', [A, B]]);
    // Nothing from B's empty home, and the project/local entry of a folder nobody registered is not a machine row.
    expect(rows.some(([, , runtimes]) => runtimes.length === 1 && runtimes[0] === B)).toBe(false);
    // The wire carries addresses, never arguments or environments (`toWire`).
    expect(response.body).not.toContain('--secret-arg');
    expect(response.body).not.toContain('sk-not-a-real-value');
    expect(response.body).not.toContain('"args"');
    expect(response.body).not.toContain('"env"');
    expect(inventory.problems).toEqual([]);
  });

  test('R-0162 a ferret on runtime A sees ferretry, the component, A’s user server and a local server scoped to its project', async () => {
    const { h } = await world();
    const response = await h.request('GET', '/v1/ferrets/on-a/mcp/servers', { as: as('filesystem.use') });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const inventory = response.json<McpInventory>();
    expect(view(inventory)).toEqual([
      ['ferretry', 'ferretry', [A]],
      ['docs', 'component', [A]],
      ['tool', 'user', [A]],
      ['scratch', 'local', [A]],
    ]);
    const local = inventory.servers.find(server => server.scope === 'local');
    expect(local?.project?.root).toBe('/work/app');
    expect(response.body).not.toContain('--secret-arg');
    expect(response.body).not.toContain('sk-not-a-real-value');
  });

  test('R-0162 a ferret on runtime B sees only ferretry: A’s component and servers are not in its home', async () => {
    const { h } = await world();
    const inventory = (
      await h.request('GET', '/v1/ferrets/on-b/mcp/servers', { as: as('filesystem.use') })
    ).json<McpInventory>();
    expect(view(inventory)).toEqual([['ferretry', 'ferretry', [B]]]);
  });

  test('a home is read only by the three document names, through its reader', async () => {
    const { h, asked } = await world();
    await h.request('GET', '/v1/ferrets/on-a/mcp/servers', { as: as('filesystem.use') });
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['.claude.json']));
  });

  test('a launch on runtime B gets no `docs` part, and one on runtime A gets it', async () => {
    const half = await launchSource();
    const spec = (runtime: string | undefined) =>
      ({
        ferret: ferretId('on-a'),
        role: 'lead',
        harness: 'claude-code',
        folder: '/work/app',
        home: '/h',
        runtime,
      }) as never;
    const names = async (runtime: string | undefined) =>
      (await half.parts(spec(runtime))).flatMap(part => (part.kind === 'mcp' ? [part.name] : []));
    expect(await names(A)).toEqual(['docs']);
    expect(await names(B)).toEqual([]);
    // No runtime: no item (D10), as in v4 where a launch with no fleet account had no components.
    expect(await names(undefined)).toEqual([]);
  });
});

/** The launch source the daemon half contributes, built over the same two runtimes. */
async function launchSource(): Promise<LaunchPartSource> {
  const { default: daemon } = await import('../../daemon/index.ts');
  const { default: manifest } = await import('../../manifest.ts');
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('on-a'), folder: '/work/app', runtime: A } as never);
  const runtimes = fakeRuntimes();
  runtimes.setProfiles(
    [],
    [
      { runtime: A, profile: 'full', mcp: ['docs'], skills: [] },
      { runtime: B, profile: 'bare', mcp: [], skills: [] },
    ],
  );
  const half = daemon.build?.({
    manifest,
    needs: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    uses: {
      claudeCode: { current: () => undefined },
      projects: { current: () => undefined },
      runtimes: { current: () => runtimes },
    },
    hooks: {} as never,
    kernel: {
      config: { collection: () => new Map(Object.entries(ITEMS)) },
      clock: { nowMs: () => 0 },
      roots: { root: () => ({ resolve: () => ({ ok: false }) }) },
    },
  } as never);
  const hooks = half?.hooks as unknown as Record<string, () => readonly { item: LaunchPartSource }[]>;
  const source = hooks['launch.parts']?.()[0]?.item;
  if (source === undefined) throw new Error('MCP contributes no launch.parts source');
  return source;
}
