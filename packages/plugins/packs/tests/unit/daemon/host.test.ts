import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { FerretResultSchema, PackTableSchema, PackViewSchema, PacksPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { DEFAULT_PACK_CONFIG } from '../../../contract/index.ts';
import { launchEnvironment, startDecision } from '../../../daemon/lib/hooks.ts';

let who: CallStanding = ownerStanding();
const asFerret = (id: string): void => {
  who = ferretStanding(ferretId(id));
};
const asOwner = (): void => {
  who = ownerStanding();
};

async function host(setup: (ferrets: FakeFerrets) => void = () => {}) {
  const ferrets = new FakeFerrets();
  setup(ferrets);
  who = ownerStanding();
  return {
    ferrets,
    host: await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => who),
      fakes: { ferrets, vault: new FakeVault() },
    }),
  };
}

const lead = ferretId('lead');

describe('the start.decide and launch.parts decisions', () => {
  test('a start with no known parent is not refused', () => {
    expect(startDecision(undefined, DEFAULT_PACK_CONFIG.limits)).toEqual({ allow: true });
  });
  test('a parent at its width limit is refused with the sentence and its remedy', () => {
    const decision = startDecision(
      { id: 'lead', interactive: false, depth: 0, runningChildren: DEFAULT_PACK_CONFIG.limits.autoChildren },
      DEFAULT_PACK_CONFIG.limits,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain('already has');
  });
  test('a child that would be too deep is refused', () => {
    const { maxDepth } = DEFAULT_PACK_CONFIG.limits;
    const decision = startDecision(
      { id: 'deep', interactive: true, depth: maxDepth, runningChildren: 0 },
      DEFAULT_PACK_CONFIG.limits,
    );
    expect(decision.allow).toBe(false);
  });
  test('a ferret that is told gets the routing line; one that is not gets only the off flag', async () => {
    const on = await launchEnvironment(
      { ...DEFAULT_PACK_CONFIG, enabled: true },
      { eligible: true, ownSwitch: undefined, depth: 0 },
      async () => 'line',
    );
    expect(on).toEqual({ FY_PACK: '1', FY_PACK_ROUTING: 'line' });
    const off = await launchEnvironment(
      { ...DEFAULT_PACK_CONFIG, enabled: true },
      { eligible: true, ownSwitch: false, depth: 0 },
      async () => {
        throw new Error('not derived for a ferret that is not told');
      },
    );
    expect(off).toEqual({ FY_PACK: '0' });
  });
});

describe('packs on the test host', () => {
  test('GET /v1/pack answers the settings view even with Runtimes and Usage off', async () => {
    const { host: h } = await host();
    const response = await h.request('GET', '/v1/pack');
    expect(response.status).toBe(200);
    expect(PackViewSchema.safeParse(response.json()).success).toBe(true);
    await h.stop();
  });

  test('a finished ferret with no `signal done` message has a result with no summary; an unknown ferret is 404', async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead, state: 'stopped' }));
    const response = await h.request('GET', '/v1/ferrets/lead/result');
    expect(response.status).toBe(200);
    const result = FerretResultSchema.parse(response.json());
    expect([result.finished, result.summary]).toEqual([true, undefined]);
    expect((await h.request('GET', '/v1/ferrets/nobody/result')).status).toBe(404);
    await h.stop();
  });

  test("a lead reads its own pack's table; another ferret may not", async () => {
    const { host: h } = await host(ferrets => {
      ferrets.add({ id: lead });
      ferrets.add({ id: ferretId('kid'), parent: lead, state: 'working' });
      ferrets.add({ id: ferretId('other') });
    });
    asFerret('lead');
    const own = await h.request('GET', '/v1/ferrets/lead/pack');
    expect(own.status).toBe(200);
    const table = PackTableSchema.parse(own.json());
    expect(table.rows.map(row => [row.id, row.depth, row.state])).toEqual([['kid', 1, 'running']]);
    asFerret('other');
    const stranger = await h.request('GET', '/v1/ferrets/lead/pack');
    expect(stranger.status).toBe(403);
    asOwner();
    expect((await h.request('GET', '/v1/ferrets/nobody/pack')).status).toBe(404);
    await h.stop();
  });

  test('a ferret may only start its own helpers: naming another parent is refused', async () => {
    const { host: h } = await host(ferrets => {
      ferrets.add({ id: lead });
      ferrets.add({ id: ferretId('other') });
    });
    asFerret('lead');
    const response = await h.request('POST', '/v1/pack/new', {
      body: { task: 'do it', runtime: 'claude', parent: 'other' },
    });
    expect([response.status, response.json<{ code: string }>().code]).toEqual([403, 'parent_mismatch']);
    await h.stop();
  });

  test('a start with a parent at its width limit is refused as an answer, with its closed code', async () => {
    const { host: h } = await host(ferrets => {
      ferrets.add({ id: lead, mode: 'auto' });
      for (let index = 0; index < DEFAULT_PACK_CONFIG.limits.autoChildren; index += 1)
        ferrets.add({ id: ferretId(`kid${String(index)}`), parent: lead, state: 'working' });
    });
    asFerret('lead');
    const response = await h.request('POST', '/v1/pack/new', {
      body: { task: 'one more', runtime: 'claude' },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'refused', refusal: { code: 'limit_reached' } });
    await h.stop();
  });

  test("a ferret's own switch is kept, read back by `instructed`, and refused for an unknown ferret", async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead, state: 'working' }));
    const packs = h.provided(PacksPort);
    expect(await packs.instructed(lead)).toBe(true);
    const response = await h.request('PATCH', '/v1/ferrets/lead/pack', { body: { enabled: false } });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ restartRequired: true });
    expect(await packs.instructed(lead)).toBe(false);
    expect((await h.request('PATCH', '/v1/ferrets/nobody/pack', { body: { enabled: true } })).status).toBe(404);
    await h.stop();
  });

  test('accepting a routing prompt says plainly that the configuration writer is not available yet', async () => {
    const { host: h } = await host();
    const response = await h.request('POST', '/v1/pack/routing/accept', {
      body: {
        prompt: 'Use the best model for planning.',
        suggested: { by: 'a model', via: 'a runtime', mode: 'clean-up', at: '2026-11-07T10:00:00.000Z' },
      },
    });
    expect(response.status).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('config_write_unavailable');
    await h.stop();
  });

  test('a ferret cannot start a clean-up, accept or undo: only a person does', async () => {
    const { host: h } = await host(ferrets => ferrets.add({ id: lead }));
    for (const path of ['/v1/pack/routing/clean-up', '/v1/pack/routing/accept', '/v1/pack/routing/undo']) {
      asFerret('lead');
      const response = await h.request('POST', path, { body: {} });
      expect([path, response.status]).toEqual([path, 403]);
    }
    await h.stop();
  });
});
