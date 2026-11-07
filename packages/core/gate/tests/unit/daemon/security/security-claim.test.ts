import { describe, expect, test } from 'bun:test';
import type { CallContext, CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { STEP_UP_REQUIRED_CODE, type SecuritySettings } from '../../../../contract/index.ts';
import { judgeLooseningWrite } from '../../../../daemon/lib/policy/config-judge.ts';
import { gateRoutes } from '../../../../daemon/lib/routes.ts';
import { SecuritySettingsService } from '../../../../daemon/lib/security/service.ts';
import { admit, descriptor, world } from '../support.ts';

/**
 * ONE PROOF, ONE ACT across `PATCH /v1/security` and the config judge (the step-up-snapshot r1 finding 1): every
 * standing is built by REAL Gate admission, and every one is taken as fresh BEFORE any of them runs, so a route that
 * reads the admission snapshot would let all of them through.
 */
const route = descriptor({ consultsGrants: true });
const subject = { deviceId: 'phone', appSession: 's-phone' };

function setup() {
  const w = world();
  w.enrol('phone');
  w.stepUps.grant(subject);
  let taken = 0;
  const real = w.stepUps.claimFresh;
  Object.assign(w.stepUps, {
    claimFresh: (...args: Parameters<typeof real>) => {
      const claimed = real(...args);
      if (claimed) taken += 1;
      return claimed;
    },
  });
  const writes: SecuritySettings[] = [];
  const security = new SecuritySettingsService({
    document: { read: () => ({ kind: 'defaults' }), write: async settings => void writes.push(settings) },
    history: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    widenCommand: 'fy daemon security set',
  });
  const routes = gateRoutes({
    audit: { recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }) },
    security,
  });
  /** A device call, as the kernel builds it: a COPY of the standing beside the request. */
  const callAs = (body: unknown): { call: CallContext; standing: CallStanding } => {
    const { decision, call } = admit(w, route, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.standing.presentation?.freshStepUp).toBe(true);
    return {
      standing: decision.standing,
      call: {
        ...decision.standing,
        request: { ...call, text: async () => JSON.stringify(body) },
        params: {},
      } as unknown as CallContext,
    };
  };
  const standingOf = (): CallStanding => callAs({}).standing;
  return { w, taken: () => taken, writes, routes, callAs, standingOf };
}

const looseningOf = (standing: CallStanding): ConfigWriteJudgement => ({
  plugin: 'fleet',
  path: 'fleet.yaml',
  removal: false,
  sentences: ['the budget rose'],
  actor: 'owner-viewer',
  standing,
});

const answered = async (run: Promise<{ status: number; body: string }>): Promise<number> => (await run).status;
const refusedWith = async (run: Promise<unknown>): Promise<number> => {
  try {
    await run;
    return 200;
  } catch (error) {
    return (error as { status: number }).status;
  }
};

describe('G114 G115 PATCH /v1/security takes the proof it widens on, in the queue', () => {
  test('G114 G115 two security raises admitted on one proof, both snapshotted fresh: exactly one raises, the other asks again', async () => {
    const { taken, writes, routes, callAs } = setup();
    const first = callAs({ unlockValidityHours: 12 });
    const second = callAs({ unlockValidityHours: 24 });
    const results = await Promise.all([
      routes['PATCH /v1/security'](first.call),
      routes['PATCH /v1/security'](second.call),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 403]);
    const refused = results.find(result => result.status === 403);
    expect(JSON.parse(refused?.body ?? '{}')).toMatchObject({ code: STEP_UP_REQUIRED_CODE });
    expect(writes).toHaveLength(1);
    expect(taken()).toBe(1);
  });

  test('G114 G115 G131 a security raise and a config loosening on one proof, the loosening judged first: exactly one applies', async () => {
    const { taken, writes, routes, callAs, standingOf } = setup();
    const widen = callAs({ unlockValidityHours: 12 });
    const config = standingOf();
    const loosening = judgeLooseningWrite(looseningOf(config));
    const status = await answered(routes['PATCH /v1/security'](widen.call));
    expect([loosening, status]).toEqual(['apply', 403]);
    expect(writes).toEqual([]);
    expect(taken()).toBe(1);
  });

  test('G114 G115 G131 a security raise and a config loosening on one proof, the raise first: exactly one applies', async () => {
    const { taken, writes, routes, callAs, standingOf } = setup();
    const widen = callAs({ unlockValidityHours: 12 });
    const config = standingOf();
    const status = await answered(routes['PATCH /v1/security'](widen.call));
    const loosening = judgeLooseningWrite(looseningOf(config));
    expect([status, loosening]).toEqual([200, 'hold']);
    expect(writes).toHaveLength(1);
    expect(taken()).toBe(1);
  });

  test('G114 G115 G131 a security raise and a config loosening started together on one proof: exactly one applies', async () => {
    const { taken, routes, callAs, standingOf } = setup();
    const widen = callAs({ unlockValidityHours: 12 });
    const config = standingOf();
    const pending = routes['PATCH /v1/security'](widen.call);
    const loosening = judgeLooseningWrite(looseningOf(config));
    const status = await answered(pending);
    expect([status === 200, loosening === 'apply'].filter(Boolean)).toHaveLength(1);
    expect(taken()).toBe(1);
  });

  test('G112 G116 a widen no passkey could buy takes no proof, and the proof still serves a raise', async () => {
    const { taken, writes, routes, callAs } = setup();
    expect(await refusedWith(routes['PATCH /v1/security'](callAs({ stepUpWindowMinutes: 30 }).call))).toBe(403);
    expect(taken()).toBe(0);
    expect(await answered(routes['PATCH /v1/security'](callAs({ unlockValidityHours: 12 }).call))).toBe(200);
    expect(writes).toHaveLength(1);
    expect(taken()).toBe(1);
  });

  test('G111 a patch that widens nothing claims nothing and still applies, so the proof stays for the next act', async () => {
    const { w, taken, writes, routes, callAs } = setup();
    expect(await answered(routes['PATCH /v1/security'](callAs({ unlockValidityHours: 2 }).call))).toBe(200);
    expect(writes).toHaveLength(1);
    expect(taken()).toBe(0);
    expect(w.stepUps.freshlyHeld(subject)).toBe(true);
  });
});
