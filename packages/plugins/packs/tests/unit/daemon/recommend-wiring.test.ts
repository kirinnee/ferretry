/**
 * `fy recommend`, `fy guide show` and `fy guide inventory` answer from the REAL ports (triage row 10): the Runtimes catalog,
 * the Logins list and catalogs, and Usage's feed. The fakes here are those plugins' own contract fakes, so a member Packs
 * calls that the real provider does not offer fails here, as it did on a machine ("the daemon failed to handle this request").
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { RuntimeIdSchema, type RuntimeSummary, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { fakeUsage } from '@ferretry/plugin-usage/contract/testing';
import type { UsageApi } from '@ferretry/plugin-usage/contract';
import { PackInventorySchema, PackRecommendationSchema, PackViewSchema } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { choice, runtime, tool } from './support.ts';

/** The summary Runtimes' own `list()` and `resolve()` answer for a catalog row. */
const summaryOf = (view: RuntimeView): RuntimeSummary => ({
  id: RuntimeIdSchema.parse(view.name),
  harness: view.harness,
  login: view.credential.id,
  profile: view.profile,
  agent: view.agent,
  launch: view.launch,
});

const opus = runtime('claude-main', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
const gpt = runtime('codex-main', {
  harness: 'codex',
  catalogId: 'openai',
  choices: [choice('gpt-6.1-sol', 'GPT 6.1 Sol')],
});

async function host(
  options: { readonly usage?: UsageApi; readonly fiveHourUsed?: Readonly<Record<string, number>> } = {},
) {
  const runtimes = fakeRuntimes();
  runtimes.setCatalog([opus, gpt], [tool('claude-code', true), tool('codex', true)]);
  runtimes.setRuntimes([opus, gpt].map(summaryOf));
  const used = options.fiveHourUsed ?? {};
  const logins = fakeLogins(
    ['claude-main-login', 'codex-main-login'].map(id =>
      sampleLogin(id, {
        usage: { fiveHour: used[id] === undefined ? {} : { usedPercent: used[id] }, weekly: {} },
      }),
    ),
  );
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { ferrets: new FakeFerrets() },
    uses: { runtimes, logins, usage: options.usage ?? fakeUsage() },
  });
}

describe('fy recommend and fy guide on the real ports', () => {
  test('POST /v1/pack/recommend lists every usable model with its start command, and what to try first', async () => {
    const h = await host();

    const response = await h.request('POST', '/v1/pack/recommend', { body: {} });

    expect(response.status).toBe(200);
    const recommendation = PackRecommendationSchema.parse(response.json());
    expect(recommendation.available.map(option => [option.model, option.runtime, option.ready])).toEqual([
      ['gpt-6.1-sol', 'codex-main', true],
      ['opus', 'claude-main', true],
    ]);
    expect(recommendation.available[1]?.command).toBe(
      'fy new --runtime claude-main --model opus --name "<short task title>" "<complete brief>"',
    );
    expect(recommendation.next).toBeDefined();
    await h.stop();
  });

  test('GET /v1/pack (guide show) and GET /v1/pack/inventory (guide inventory) answer 200 on the same facts', async () => {
    const h = await host();

    const view = await h.request('GET', '/v1/pack');
    const inventory = await h.request('GET', '/v1/pack/inventory');

    expect(view.status).toBe(200);
    expect(PackViewSchema.parse(view.json()).available).toHaveLength(2);
    expect(inventory.status).toBe(200);
    expect(PackInventorySchema.safeParse(inventory.json()).success).toBe(true);
    await h.stop();
  });

  test('the model on the login with the most quota left comes first, the one nearly spent after it', async () => {
    const h = await host({ fiveHourUsed: { 'claude-main-login': 90, 'codex-main-login': 10 } });

    const recommendation = PackRecommendationSchema.parse(
      (await h.request('POST', '/v1/pack/recommend', { body: {} })).json(),
    );

    expect(recommendation.available.map(option => option.model)).toEqual(['gpt-6.1-sol', 'opus']);
    expect(recommendation.available[1]?.quota.state).toBe('low');
    await h.stop();
  });

  test('a login Usage reports at a spend limit (a pane proved it) is listed as not ready, with why', async () => {
    const usage: UsageApi = {
      ...fakeUsage(),
      feed: async () => ({
        stale: false,
        accounts: [
          {
            agent: 'codex-main-login',
            atLimit: true,
            unavailable: true,
            availability: 'unavailable',
            unavailableReason: 'spend_limit',
            retryAt: Date.parse('2999-01-01T00:00:00Z'),
          },
        ],
      }),
    };
    const h = await host({ usage });

    const recommendation = PackRecommendationSchema.parse(
      (await h.request('POST', '/v1/pack/recommend', { body: {} })).json(),
    );

    expect(recommendation.available.map(option => [option.model, option.ready])).toEqual([
      ['opus', true],
      ['gpt-6.1-sol', false],
    ]);
    expect(recommendation.available[1]?.refusal?.code).toBe('out_of_quota');
    await h.stop();
  });
});
