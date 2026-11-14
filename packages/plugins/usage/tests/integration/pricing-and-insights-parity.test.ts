/**
 * v4 parity on the composed Usage daemon (ledger F2, F3):
 *  - `GET /v1/usage/pricing` carries the model catalogs' list prices (`modelCatalogRates`), read through ONE Logins port read;
 *  - insights read how a ferret ended from its record's `cause`, so a ferret this process never watched end (a fresh daemon,
 *    an empty `turn.ended` map) still reads completed / failed / stopped.
 * Fake data only.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ModelPriceCatalog } from '@ferretry/plugin-logins/contract';
import usage from '../../daemon/index.ts';

const SOURCE = 'https://prices.example.test/page';
const PRICE = {
  provider: 'anthropic',
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  source: SOURCE,
  verified: '2026-11-01',
} as const;
const CATALOGS: readonly ModelPriceCatalog[] = [
  {
    id: 'anthropic',
    claude: {
      models: [
        { id: 'claude-opus-fake', price: PRICE },
        { id: 'claude-haiku-fake', price: { ...PRICE, input: 1, output: 5 } },
      ],
      tiers: { opus: 'claude-opus-fake' },
    },
  },
];

const host = async (ferrets: FakeFerrets, catalogs: readonly ModelPriceCatalog[] = []) => {
  const logins = fakeLogins([sampleLogin('work')]);
  logins.setModelPrices(catalogs);
  return await testHost({
    plugins: [usage],
    fakes: { ferrets, conversation: fakeConversation(), logins, vault: new FakeVault() },
  });
};

describe('Settings › Model pricing list prices', () => {
  test('the pricing read carries one rate per catalog model, with the tier alias', async () => {
    const h = await host(new FakeFerrets(), CATALOGS);
    const answer = await h.request('GET', '/v1/usage/pricing');
    expect(answer.status).toBe(200);
    const { modelCatalogRates } = answer.json<{
      modelCatalogRates: { modelId: string; aliases: string[]; rates: { input: number } }[];
    }>();
    expect(modelCatalogRates.map(rate => rate.modelId).sort()).toEqual(['claude-haiku-fake', 'claude-opus-fake']);
    const opus = modelCatalogRates.find(rate => rate.modelId === 'claude-opus-fake');
    expect(opus?.aliases).toEqual(['opus']);
    expect(opus?.rates.input).toBe(5_000_000);
    await h.stop();
  });

  test('a machine whose catalogs state no price has none, and the read still answers', async () => {
    const h = await host(new FakeFerrets());
    const answer = await h.request('GET', '/v1/usage/pricing');
    expect(answer.json<{ modelCatalogRates: unknown[] }>().modelCatalogRates).toEqual([]);
    await h.stop();
  });
});

describe('Insights history: how a ferret ended', () => {
  const endings = async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('done'), state: 'stopped', login: 'work', cause: { kind: 'completed' } });
    ferrets.add({
      id: ferretId('crashed'),
      state: 'stopped',
      login: 'work',
      cause: { kind: 'agent_crashed', exitCode: 2 },
    });
    ferrets.add({ id: ferretId('gone'), state: 'stopped', login: 'work', cause: { kind: 'terminal_gone' } });
    ferrets.add({ id: ferretId('failed-start'), state: 'stopped', login: 'work', cause: { kind: 'start_failed' } });
    ferrets.add({ id: ferretId('halted'), state: 'stopped', login: 'work', cause: { kind: 'stopped' } });
    ferrets.add({ id: ferretId('quit'), state: 'stopped', login: 'work', cause: { kind: 'clean_exit' } });
    ferrets.add({ id: ferretId('old'), state: 'stopped', login: 'work' });
    // A FRESH host: nothing watched any of these end (the `turn.ended` map is empty), as after a daemon restart.
    const h = await host(ferrets);
    await h.runJob('usage-ingest');
    const status = async (ferret: string) => {
      const answer = await h.request('GET', '/v1/usage/insights', {
        query: { q: 'count by (status)', session: ferret },
      });
      return JSON.stringify(answer.json());
    };
    return { h, status };
  };

  test('reads completed, failed and stopped from the record cause', async () => {
    const { h, status } = await endings();
    expect(await status('done')).toContain('completed');
    for (const failed of ['crashed', 'gone', 'failed-start']) {
      const text = await status(failed);
      expect(text).toContain('failed');
      expect(text).not.toContain('stopped');
    }
    for (const stopped of ['halted', 'quit', 'old']) expect(await status(stopped)).toContain('stopped');
    await h.stop();
  });

  test('carries the login as the agent', async () => {
    const { h } = await endings();
    const answer = await h.request('GET', '/v1/usage/insights', { query: { q: 'count by (agent)', session: 'done' } });
    expect(JSON.stringify(answer.json())).toContain('work');
    await h.stop();
  });
});
