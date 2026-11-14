/**
 * `fy recommend`, `fy guide show` and `fy guide inventory` answer from the REAL ports (triage row 10): the Runtimes catalog,
 * the Logins list and catalogs, and Usage, each through that plugin's own contract fake. A member Packs calls that the real
 * provider does not offer fails here, as it did on a machine ("the daemon failed to handle this request").
 *
 * The pane evidence is Usage's own read (`UsageApi.paneLimits()`); a plugin's tests may not load another plugin's daemon half,
 * so the real Usage provider's side of it (Ferrets' reports in, feed rows and `paneLimits()` out, release and expiry) is
 * proved in Usage's own `tests/integration/pane-limits.test.ts`, and Ferrets' derivation from session documents in its
 * `pane-limits.test.ts`. Here Packs is proved to read that contract's rows and judge readiness from them.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { RuntimeIdSchema, type RuntimeSummary, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { PaneLimitView } from '@ferretry/plugin-usage/contract';
import { fakeUsage } from '@ferretry/plugin-usage/contract/testing';
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

async function host(options: { readonly fiveHourUsed?: Readonly<Record<string, number>> } = {}) {
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
  /** The limits Usage's read answers now: a test moves them, as a ferret's release or a reset would. */
  const panes = { limits: [] as readonly PaneLimitView[] };
  const usage = { ...fakeUsage(), paneLimits: async () => panes.limits };
  const h = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { ferrets: new FakeFerrets() },
    uses: { runtimes, logins, usage },
  });
  return { h, panes };
}

const recommend = async (h: Awaited<ReturnType<typeof host>>['h']) =>
  PackRecommendationSchema.parse((await h.request('POST', '/v1/pack/recommend', { body: {} })).json());
const inventory = async (h: Awaited<ReturnType<typeof host>>['h']) =>
  PackInventorySchema.parse((await h.request('GET', '/v1/pack/inventory')).json());

describe('fy recommend and fy guide on the real ports', () => {
  test('POST /v1/pack/recommend lists every usable model with its start command, and what to try first', async () => {
    const { h } = await host();

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
    const { h } = await host();

    const view = await h.request('GET', '/v1/pack');
    const inventoried = await inventory(h);

    expect(view.status).toBe(200);
    expect(PackViewSchema.parse(view.json()).available).toHaveLength(2);
    expect(inventoried.runtimes.map(runtime => [runtime.name, runtime.ready])).toEqual([
      ['claude-main', true],
      ['codex-main', true],
    ]);
    await h.stop();
  });

  test('the model on the login with the most quota left comes first, the one nearly spent after it', async () => {
    const { h } = await host({ fiveHourUsed: { 'claude-main-login': 90, 'codex-main-login': 10 } });

    const recommendation = await recommend(h);

    expect(recommendation.available.map(option => option.model)).toEqual(['gpt-6.1-sol', 'opus']);
    expect(recommendation.available[1]?.quota.state).toBe('low');
    await h.stop();
  });
});

describe("the limits a live pane proves, read from Usage's own paneLimits()", () => {
  const windows = { fiveHourUsed: { 'claude-main-login': 10, 'codex-main-login': 10 } };

  test('a spend limit on one login makes its models not ready and out of quota; the unaffected login stays ready', async () => {
    const { h, panes } = await host(windows);
    panes.limits = [{ login: 'codex-main-login', notice: 'Spend limit reached', spend: true }];

    const recommendation = await recommend(h);
    const inventoried = await inventory(h);

    expect(recommendation.available.map(option => [option.model, option.ready])).toEqual([
      ['opus', true],
      ['gpt-6.1-sol', false],
    ]);
    expect(recommendation.available[1]?.refusal?.code).toBe('out_of_quota');
    expect(recommendation.available[1]?.quota.state).toBe('exhausted');
    expect(inventoried.runtimes.map(runtime => [runtime.name, runtime.ready])).toEqual([
      ['claude-main', true],
      ['codex-main', false],
    ]);
    await h.stop();
  });

  test('a usage limit with no reset time, on a login whose windows are under full, holds until the limited ferret is released', async () => {
    const { h, panes } = await host(windows);
    panes.limits = [{ login: 'codex-main-login', notice: "You've hit your usage limit", spend: false }];

    const held = await recommend(h);
    const heldInventory = await inventory(h);
    panes.limits = [];
    const released = await recommend(h);

    expect(held.available.map(option => [option.model, option.ready, option.quota.state])).toEqual([
      ['opus', true, 'plenty'],
      ['gpt-6.1-sol', false, 'exhausted'],
    ]);
    expect(held.available[1]?.refusal?.code).toBe('out_of_quota');
    expect(heldInventory.runtimes.find(runtime => runtime.name === 'codex-main')?.quota.state).toBe('exhausted');
    expect(released.available.map(option => [option.model, option.ready])).toEqual([
      ['gpt-6.1-sol', true],
      ['opus', true],
    ]);
    await h.stop();
  });

  test('a limit whose reset time has passed blocks nothing', async () => {
    const { h, panes } = await host(windows);
    panes.limits = [
      { login: 'codex-main-login', notice: 'limit', spend: false, retryAt: Date.parse('2020-01-01T00:00:00Z') },
    ];

    const recommendation = await recommend(h);

    expect(recommendation.available.every(option => option.ready)).toBe(true);
    await h.stop();
  });

  test('a ferret that records no login blocks the login its runtime maps to', async () => {
    const { h, panes } = await host(windows);
    panes.limits = [{ runtime: 'claude-main', notice: 'limit', spend: false }];

    const recommendation = await recommend(h);

    expect(recommendation.available.map(option => [option.model, option.ready])).toEqual([
      ['gpt-6.1-sol', true],
      ['opus', false],
    ]);
    await h.stop();
  });
});
