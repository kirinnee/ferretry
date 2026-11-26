/**
 * U4b part 4a fix round (G1 #2570): a runtime is installed into by its harness PLUGIN KEY, never by the word a catalog
 * names a harness. A third plugin may register under the key `claude`; that is not Claude's key (`claude-code`), so its
 * runtime is refused BY KEY at the ROUTE, takes no preview slot, and the next supported request still succeeds.
 * It goes through Catalogs' REAL item-provider adapter (Skills first, the MCP fallback when Skills is off), the real service and
 * the real route. The providers' runtime answers what the real Skills and MCP adapters answer (the runtime's plugin key,
 * unchanged: each package's own tests pin that), because another package's daemon half is not importable from here.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { CatalogItems } from '../../../contract/items/index.ts';
import { itemProviders } from '../../../daemon/adapters/items.ts';
import { catalogInstallRoutes } from '../../../daemon/lib/routes/catalog-installs.ts';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { mcpItem, newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { request, rig, runtimeTarget, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

/** A kind's provider as Skills and MCP answer the targets: each runtime by id, profile and its harness plugin KEY. */
const provider = (kind: 'skill' | 'mcp') => ({
  kind,
  runtime: {
    runtimes: async () => ({
      runtimes: [
        { id: 'rt-claude', name: 'rt-claude', profile: 'work', harness: 'claude-code' },
        { id: 'rt-codex', name: 'rt-codex', profile: 'work', harness: 'codex' },
        { id: 'rt-third', name: 'rt-third', profile: 'work', harness: 'claude' },
      ],
    }),
    profiles: async () => ({ profiles: [{ name: 'work' }] }),
    storedComponent: async () => undefined,
  },
});

const realFleet = (on: { skills: boolean; mcp: boolean }) => {
  const hooks = {
    provider: (hook: unknown, kind: 'skill' | 'mcp') =>
      hook !== CatalogItems || !(kind === 'skill' ? on.skills : on.mcp) ? 'unavailable' : provider(kind),
  };
  return itemProviders(hooks as never, { current: () => undefined } as never).runtime as never;
};

type Handle = (context: never) => Promise<{ status: number; body: string }>;
const PREVIEW = '/v1/catalog-installs/runtime/preview';

const preview = (r: Rig, body: unknown) => {
  const found = catalogInstallRoutes(r.inner).find(route => route.method === 'POST' && route.path === PREVIEW);
  if (found === undefined) throw new Error('no preview route');
  return (found.handle as unknown as Handle)({
    credential: undefined,
    actor: undefined,
    governance: { governed: false, decide: () => ({ allowed: true }) },
    params: new Map(),
    request: { query: new Map(), headers: new Map(), text: async () => JSON.stringify(body) },
  } as never);
};

const refusedOf = async (work: Promise<unknown>): Promise<ApiError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('a runtime on a third harness that registered under the key `claude`', () => {
  const cases = [
    {
      adapter: 'Skills',
      on: { skills: true, mcp: false },
      item: () => skillItem(alice.daemonId, { harness: 'claude' }),
    },
    { adapter: 'Skills (MCP also on)', on: { skills: true, mcp: true }, item: () => mcpItem(alice.daemonId) },
    { adapter: 'the MCP fallback', on: { skills: false, mcp: true }, item: () => mcpItem(alice.daemonId) },
  ] as const;
  for (const { adapter, on, item } of cases)
    it(`should be refused by key at the route, take no slot, and leave the next request working (${adapter})`, async () => {
      // Arrange
      const r = rig({ fleet: realFleet(on) });

      // Act
      const refused = await refusedOf(preview(r, await request(alice, item(), runtimeTarget('rt-third'))));

      // Assert
      expect(refused.status).toBe(422);
      expect(refused.code).toBe('catalog_not_installable');
      expect(refused.message).toMatch(/\bclaude\b/u);
      expect(r.previews.size).toBe(0);
      const next = await preview(r, await request(alice, item(), runtimeTarget('rt-claude')));
      expect(next.status).toBe(200);
      expect(r.previews.size).toBe(1);
    });
});
