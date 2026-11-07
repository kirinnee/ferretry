import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import { deviceStanding, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import {
  HousekeepingFile,
  ScratchPlanListSchema,
  TidyPlanSchema,
  TidyPort,
  TidyTotalsSchema,
} from '../../contract/index.ts';
import { ScratchCollector } from '../../daemon/lib/scratch-collector.ts';
import { tidyRoutes } from '../../daemon/lib/routes.ts';
import { SCRATCH_DEFAULTS } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { at, HOUR, MemoryFolders, NOW, ROOT } from './support.ts';

const call = (opts: { body?: unknown; query?: Record<string, string[]>; raw?: string } = {}): CallContext =>
  ({
    request: {
      query: new Map(Object.entries(opts.query ?? {})),
      text: async () => opts.raw ?? JSON.stringify(opts.body ?? {}),
    } as unknown as ApiRequest,
    params: new Map(),
  }) as CallContext;

function routes() {
  const folders = new MemoryFolders();
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), state: 'stopped', folder: `${ROOT}/f1`, stateAt: at(NOW - 48 * HOUR) });
  folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/n`, 40);
  const collector = new ScratchCollector({
    ferrets,
    worktrees: folders,
    nowMs: () => NOW,
    config: () => SCRATCH_DEFAULTS,
    record: async () => {},
  });
  const planner = { plan: async () => ({ ok: false as const, message: 'unused' }) };
  return tidyRoutes(collector, planner);
}

const json = (response: { body: string }): unknown => JSON.parse(response.body);

describe('GET /v1/gc and POST /v1/gc', () => {
  test('GET answers the wire plan; a limit must be a whole number and nothing else is a parameter', async () => {
    const r = routes();
    expect(ScratchPlanListSchema.safeParse(json(await r['GET /v1/gc'](call()))).success).toBe(true);
    await expect(r['GET /v1/gc'](call({ query: { limit: ['0'] } }))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_limit',
    });
    await expect(r['GET /v1/gc'](call({ query: { sort: ['x'] } }))).rejects.toMatchObject({
      status: 400,
      code: 'unknown_parameter',
    });
  });
  test('POST sweeps and answers what it reclaimed', async () => {
    const r = routes();
    expect(json(await r['POST /v1/gc'](call({ body: { force: false } })))).toEqual({
      ferrets: 1,
      bytes: 40,
      failures: 0,
    });
  });
  test('POST takes a JSON body of the sweep request and nothing else', async () => {
    const r = routes();
    await expect(r['POST /v1/gc'](call({ raw: '{oops' }))).rejects.toMatchObject({ status: 400 });
    await expect(r['POST /v1/gc'](call({ body: { force: true, extra: 1 } }))).rejects.toMatchObject({ status: 422 });
  });
});

describe('tidy on the test host', () => {
  /** Gate's stand-in admission: who calls is whatever the test says, as the real Gate would stamp it. */
  const gateFor = (standing: () => CallStanding) => new StandInAdmission(() => standing());

  async function host(standing: () => CallStanding = () => ferretStanding(ferretId('lead'))) {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('lead') });
    const base = fakeBoard();
    const board = {
      ...base,
      cards: async (query: Parameters<typeof base.cards>[0]) =>
        (await base.cards(query)).map(card => ({ ...card, origin: 'agent' as const })),
      switchOf: async (project: string) => ({
        projectId: project as never,
        on: false,
        setBy: 'default' as const,
        setAt: null,
      }),
    };
    await board.create(ferretId('lead'), {
      kind: 'chore',
      title: 'Throwaway',
      summary: '',
      ask: { text: 'x', source: 'test' },
      premise: '',
      context: '',
      terms: [],
      brief: '',
      howToTest: '',
      workflow: 'quick',
      parent: null,
      assignee: null,
      dependsOn: [],
      files: [],
      docs: [],
    });
    return await testHost({
      plugins: [daemon],
      gate: gateFor(standing),
      fakes: { ferrets, asks: new FakeAsks() },
      uses: { board },
    });
  }

  test('POST /v1/tidy/plan plans the calling ferret’s own work, named by its credential', async () => {
    const h = await host();
    const response = await h.request('POST', '/v1/tidy/plan');
    expect(response.status).toBe(200);
    const plan = response.json();
    expect(TidyPlanSchema.safeParse(plan).success).toBe(true);
    expect((plan as { ferret: string }).ferret).toBe('lead');
    expect((plan as { drop: unknown[] }).drop).toHaveLength(1);
    await h.stop();
  });

  test('the plan refuses the owner at the machine and a paired device, who have no work of their own to tidy', async () => {
    let who: CallStanding = ownerStanding();
    const h = await host(() => who);
    for (const standing of [ownerStanding(), deviceStanding('phone')]) {
      who = standing;
      const response = await h.request('POST', '/v1/tidy/plan');
      expect([response.status, response.json<{ code: string }>().code]).toEqual([403, 'forbidden']);
    }
    await h.stop();
  });

  test('without Board the plan says so, and the scratch routes still answer', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('lead') });
    const h = await testHost({
      plugins: [daemon],
      gate: gateFor(() => ferretStanding(ferretId('lead'))),
      fakes: { ferrets, asks: new FakeAsks() },
    });
    const plan = await h.request('POST', '/v1/tidy/plan');
    expect([plan.status, plan.json<{ code: string }>().code]).toEqual([503, 'unavailable']);
    expect((await h.request('GET', '/v1/gc')).status).toBe(200);
    await h.stop();
  });

  test('the port reports the totals the sweeps kept, and the sweep is a job', async () => {
    const ferrets = new FakeFerrets();
    const h = await testHost({ plugins: [daemon], fakes: { ferrets, asks: new FakeAsks() } });
    expect(await h.provided(TidyPort).totals()).toEqual({ enabled: true, reclaimedFerrets: 0, reclaimedBytes: 0 });
    h.state('tidy').plant(HousekeepingFile, JSON.stringify({ format: 1, reclaimedFerrets: 3, reclaimedBytes: 900 }));
    const totals = await h.provided(TidyPort).totals();
    expect(TidyTotalsSchema.safeParse(totals).success).toBe(true);
    expect(totals).toEqual({ enabled: true, reclaimedFerrets: 3, reclaimedBytes: 900 });
    expect(h.jobIds()).toContain('scratch-sweep');
    await h.stop();
  });
});
