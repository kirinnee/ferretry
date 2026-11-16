import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { ReferenceCatalogEntrySchema, type ReferenceCatalogProvider } from '@ferretry/plugin-conversation/contract';
import { BoardPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

/** Board's half over the test host, built the way the daemon builds it; `uses` is what is on besides Board. */
const boot = async (uses: Record<string, unknown> = {}) => {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1') });
  const taken: { hooks?: Record<string, unknown> } = {};
  const capturing = {
    ...daemon,
    build: (ctx: never) => {
      const kernel = {
        ...(ctx as { kernel: object }).kernel,
        identity: { daemonId: 'fy_daemon_test0000000000000000000000000000000000000', daemonName: 'test-host' },
      };
      const half = (daemon.build as (ctx: never) => { hooks: Record<string, unknown> })({
        ...(ctx as object),
        kernel,
      } as never);
      taken.hooks = half.hooks;
      return half;
    },
  } as typeof daemon;
  const host = await testHost({ plugins: [capturing], fakes: { asks: new FakeAsks(), ferrets }, uses });
  return { host, taken };
};

describe('board provides the & menu with Conversation off', () => {
  test('the plugin boots without Conversation, keeps working, and nothing asks its provider', async () => {
    const { host, taken } = await boot();
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
    // Board still answers its own reads with Conversation absent.
    expect(await host.provided(BoardPort).cards({ state: 'all', limit: 10 })).toEqual([]);
    // The provider is held under the one key Conversation would ask, and no other prefix is claimed.
    const keys = Object.keys(taken.hooks ?? {}).filter(key => key.startsWith('reference.catalog'));
    expect(keys).toEqual(['reference.catalog:&']);
    // The only asker of the provider is Conversation's references route; with Conversation off the host holds no such
    // route, so the provider is never called (the second test calls it by hand, as that route would).
  });

  test('asked directly (as Conversation would, when it is on), the provider answers contract-valid entries from a real boot', async () => {
    const { host, taken } = await boot();
    const provider = taken.hooks?.['reference.catalog:&'] as ReferenceCatalogProvider;
    expect(provider.demand).toBeDefined();
    const entries = await provider.entries({ ferret: 'f1', caller: {} });
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries).toEqual([]);
    await host.settle();
  });
});
