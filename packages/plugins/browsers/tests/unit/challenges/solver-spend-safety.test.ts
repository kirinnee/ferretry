import { describe, expect, test } from 'bun:test';
import { OwnSecret } from '@ferretry/kernel/contract';
import type { CaptchaSpend } from '../../../contract/index.ts';
import { CapSolver, CaptchaSolving, SpendLedger } from '../../../daemon/challenges/solver.ts';

const NOVEMBER = '2026-11-30T23:59:59.000Z';
const DECEMBER = '2026-12-01T00:00:01.000Z';
const WIDGET = { kind: 'turnstile', siteKey: 'synthetic-site', pageUrl: 'https://synthetic.test/form' } as const;
const COST = 1200;
const flush = async () => {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
};

function ledgerWorld(initial?: CaptchaSpend) {
  const clock = { now: NOVEMBER };
  const state = {
    value: initial,
    update: async (_file: unknown, edit: (value: CaptchaSpend | undefined) => CaptchaSpend) => {
      state.value = edit(state.value);
      return { ok: true as const, value: state.value };
    },
  };
  const ledger = new SpendLedger(state as never, () => clock.now);
  return { ledger, state, clock };
}

function vendorWorld(options: { firstCreate?: Promise<unknown>; cap?: number; noToken?: boolean } = {}) {
  const world = ledgerWorld();
  let tasks = 0;
  const solver = new CapSolver({
    ledger: world.ledger,
    secret: async () => new OwnSecret('CAPSOLVER_API_KEY', 'synthetic-key'),
    origin: 'https://synthetic.test',
    fetch: async url => {
      const body = url.endsWith('/createTask')
        ? ++tasks === 1 && options.firstCreate !== undefined
          ? await options.firstCreate
          : { errorId: 0, taskId: 'fake-task' }
        : { errorId: 0, status: 'ready', solution: options.noToken === true ? {} : { token: 'synthetic-token' } };
      return Response.json(body);
    },
    sleep: async () => undefined,
    capMicros: options.cap ?? 1_000_000,
  });
  return { ...world, solver, tasks: () => tasks };
}

function pageWorld(
  options: { taken?: boolean; onlyFirst?: boolean; readyGate?: Promise<void>; noToken?: boolean } = {},
) {
  const vendor = vendorWorld(options);
  const clock = { now: 0 };
  const widget = { value: { ...WIDGET, pageUrl: String(WIDGET.pageUrl) } };
  const solving = new CaptchaSolving({
    stealth: () => true,
    solver: {
      vendor: 'synthetic',
      ready: async () => {
        await options.readyGate;
        return undefined;
      },
      solve: request => vendor.solver.solve(request),
    },
    onPage: async (_session, id, work) =>
      work(
        {
          captchaProbe: async () => (options.onlyFirst === true && id !== 'p0' ? undefined : widget.value),
          captchaInject: async () => options.taken ?? true,
        },
        id,
      ),
    proxy: () => undefined,
    nowMs: () => clock.now,
    audit: async () => undefined,
    failed: () => undefined,
  });
  return { ...vendor, solving, pageClock: clock, widget };
}

describe('MUST 1–5: challenge purchases preserve spend and paid widgets', () => {
  test('MUST 1: November refund after rollover leaves December charged and capped', async () => {
    const gate = Promise.withResolvers<unknown>();
    const world = vendorWorld({ firstCreate: gate.promise, cap: COST });
    const november = world.solver.solve(WIDGET);
    await flush();
    expect(world.tasks()).toBe(1);
    world.clock.now = DECEMBER;
    expect(await world.solver.solve(WIDGET)).toEqual({ token: 'synthetic-token' });
    gate.resolve({ errorId: 1, errorCode: 'ERROR_SYNTHETIC_REFUSAL' });
    await november;
    expect(await world.ledger.spent()).toBe(COST);
    world.clock.now = NOVEMBER;
    expect(await world.ledger.spent()).toBe(0);
    world.clock.now = DECEMBER;
    expect(await world.solver.solve(WIDGET)).toHaveProperty('refused', 'cap');
    expect(world.tasks()).toBe(2);
  });

  test('MUST 2: twelve future months cannot erase current November spend', async () => {
    const earlier = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`2027-${String(i + 1).padStart(2, '0')}`, 1]),
    );
    const world = ledgerWorld({ month: '2026-11', micros: 500, earlier });
    world.clock.now = '2026-10-01T00:00:00.000Z';
    await world.ledger.reserve(1, COST);
    world.clock.now = NOVEMBER;
    expect(await world.ledger.spent()).toBe(500);
  });

  test('MUST 2: a stored full-cap November reservation refuses a second one despite future months', async () => {
    const earlier = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`2027-${String(i + 1).padStart(2, '0')}`, 1]),
    );
    const world = ledgerWorld({ month: '2026-11', micros: 0, earlier });
    await world.ledger.reserve(COST, COST);
    const second = await world.ledger.reserve(COST, COST);
    expect(second).toBe('cap');
    expect(await world.ledger.spent()).toBe(COST);
  });

  test('MUST 3: a rejected paid answer is not bought again after cooldown', async () => {
    const world = pageWorld({ taken: false });
    await world.solving.begin('session', 'p0');
    await flush();
    world.pageClock.now += 6 * 60_000;
    expect(await world.solving.begin('session', 'p0')).toHaveProperty('kind', 'not-solving');
    await flush();
    expect(world.tasks()).toBe(1);
    expect(await world.ledger.spent()).toBe(COST);
    world.widget.value = { ...WIDGET, pageUrl: 'https://synthetic.test/new-form' };
    expect(await world.solving.begin('session', 'p0')).toHaveProperty('kind', 'solving');
    await flush();
    expect(world.tasks()).toBe(2);
  });

  test('MUST 4: 256 unrelated refusals cannot evict a live paid solved widget', async () => {
    const world = pageWorld({ onlyFirst: true });
    await world.solving.begin('session', 'p0');
    await flush();
    for (let i = 1; i <= 256; i += 1) await world.solving.begin('session', `p${String(i)}`);
    expect(await world.solving.begin('session', 'p0')).toHaveProperty('kind', 'solved');
    await flush();
    expect(world.tasks()).toBe(1);
    expect(await world.ledger.spent()).toBe(COST);
  });

  test('MUST 4: full paid memory refuses new purchases and keeps its oldest widget', async () => {
    const world = pageWorld();
    for (let i = 0; i < 256; i += 1) {
      await world.solving.begin('session', `p${String(i)}`);
      await flush();
    }
    expect(await world.solving.begin('session', 'p256')).toHaveProperty('kind', 'not-solving');
    await flush();
    expect(await world.solving.begin('session', 'p0')).toHaveProperty('kind', 'solved');
    expect(world.tasks()).toBe(256);
  });

  test('MUST 4: a billed task without a token survives cooldown and refusal churn', async () => {
    const world = pageWorld({ onlyFirst: true, noToken: true });
    await world.solving.begin('session', 'p0');
    await flush();
    world.pageClock.now += 6 * 60_000;
    for (let i = 1; i <= 256; i += 1) await world.solving.begin('session', `p${String(i)}`);
    expect(await world.solving.begin('session', 'p0')).toHaveProperty('kind', 'not-solving');
    await flush();
    expect(world.tasks()).toBe(1);
    expect(await world.ledger.spent()).toBe(COST);
  });

  test('MUST 5: concurrent calls claim one in-flight slot before probing and readiness', async () => {
    const gate = Promise.withResolvers<void>();
    const world = pageWorld({ readyGate: gate.promise });
    const calls = [world.solving.begin('session', 'p0'), world.solving.begin('session', 'p0')];
    await flush();
    gate.resolve();
    await Promise.all(calls);
    await flush();
    expect(world.tasks()).toBe(1);
    expect(await world.ledger.spent()).toBe(COST);
  });
});
