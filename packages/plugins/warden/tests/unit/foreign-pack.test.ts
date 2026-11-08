import { describe, it } from 'bun:test';
import should from 'should';
import {
  type FleetCredentialView,
  type FleetRuntimeView,
  type PackFleetFacts,
  quotaOf,
  runtimeRefusal,
} from '../../daemon/lib/foreign-pack.ts';

const NOW = '2026-10-30T12:00:00.000Z';

const credential = (overrides: Partial<FleetCredentialView> = {}): FleetCredentialView => ({
  id: 'login-a',
  status: { word: 'ready' },
  usage: { fiveHour: {}, weekly: {} },
  ...overrides,
});

const runtime = (overrides: Partial<FleetRuntimeView> = {}): FleetRuntimeView => ({
  name: 'Claude Atelier',
  wrapper: 'claude-auto-a',
  agent: true,
  harness: 'claude',
  credential: { id: 'login-a', status: 'ready' },
  launch: { available: true },
  modelSet: { source: 'harness-default' },
  ...overrides,
});

const facts = (overrides: Partial<PackFleetFacts> = {}): PackFleetFacts => ({
  runtimes: [],
  credentials: [credential()],
  tools: [],
  unlaunchable: {},
  now: NOW,
  ...overrides,
});

describe('a login’s headroom', () => {
  it('should be unknown with no credential and when nothing was measured', () => {
    should(quotaOf(undefined, NOW)).match({ state: 'unknown', summary: 'not measured' });
    should(quotaOf(credential(), NOW)).match({ state: 'unknown', summary: 'not measured' });
  });

  it('should band the tightest window: plenty, some, low and exhausted', () => {
    const at = (used: number) => quotaOf(credential({ usage: { fiveHour: { usedPercent: used }, weekly: {} } }), NOW);
    should(at(10)).match({ state: 'plenty', leftPercent: 90, tightest: '5h', summary: '5h 10%' });
    should(at(60)).match({ state: 'some' });
    should(at(90)).match({ state: 'low' });
    should(at(100)).match({ state: 'exhausted', summary: 'out of quota' });
  });

  it('should say when an exhausted window resets, on the same day and on another', () => {
    const usage = (resetsAt: string) => ({ fiveHour: { usedPercent: 100, resetsAt }, weekly: {} });
    should(quotaOf(credential({ usage: usage('2026-10-30T18:00:00.000Z') }), NOW)?.summary).equal(
      'out of quota until 18:00Z',
    );
    should(quotaOf(credential({ usage: usage('2026-11-02T07:30:00.000Z') }), NOW)?.summary).equal(
      'out of quota until Nov 2 07:30Z',
    );
    should(quotaOf(credential({ usage: usage('later') }), NOW)?.summary).equal('out of quota until later');
  });

  it('should count a window whose reset has passed as fresh, and read the provider’s own windows', () => {
    const fresh = quotaOf(
      credential({
        usage: {
          at: '2026-10-30T11:00:00.000Z',
          fiveHour: { usedPercent: 100, resetsAt: '2026-10-30T11:30:00.000Z' },
          weekly: { usedPercent: 40 },
          provider: {
            windows: [
              { label: 'month', usedPercent: 30 },
              { label: 'week', usedPercent: 5 },
            ],
          },
        },
      }),
      NOW,
    );
    should(fresh.windows.map(window => window.label)).eql(['5h', 'week', 'month']);
    should(fresh.windows[0]).match({ reset: true, leftPercent: 100 });
    should(fresh.measuredAt).equal('2026-10-30T11:00:00.000Z');
    should(fresh.state).equal('plenty');
  });

  it('should be exhausted when the provider says no more work, until a window has reset', () => {
    const exhausted = credential({
      usage: { fiveHour: {}, weekly: {}, provider: { exhausted: true, at: NOW, windows: [] } },
    });
    should(quotaOf(exhausted, NOW)).match({ state: 'exhausted', measuredAt: NOW });
  });

  it('should be exhausted when a pane proved a spend or usage limit, until it lifts', () => {
    const held = quotaOf(credential(), NOW, {
      notice: 'monthly spend limit',
      spend: true,
      retryAt: Date.parse('2026-11-01T00:00:00.000Z'),
    });
    should(held).match({ state: 'exhausted', summary: 'hit its spend limit until Nov 1 00:00Z' });
    should(quotaOf(credential(), NOW, { notice: 'n', spend: false })).match({
      state: 'exhausted',
      summary: 'hit its usage limit',
    });
    should(quotaOf(credential(), undefined, { notice: 'n', spend: false, retryAt: 1 }).state).equal('exhausted');
    should(quotaOf(credential(), NOW, { notice: 'n', spend: false, retryAt: Date.parse(NOW) - 1 }).state).equal(
      'unknown',
    );
  });
});

describe('why a runtime cannot start a ferret', () => {
  const refusal = (r: FleetRuntimeView, model: string | undefined, f: PackFleetFacts) => runtimeRefusal(r, model, f);

  it('should accept a runtime that is ready', () => {
    should(refusal(runtime(), undefined, facts())).be.undefined();
  });

  it('should refuse a runtime that is not an agent', () => {
    should(refusal(runtime({ agent: false }), undefined, facts())).match({ code: 'not_agent' });
  });

  it('should refuse a runtime whose CLI is not installed', () => {
    const missing = facts({ tools: [{ harness: 'claude', label: 'Claude Code', installed: false }] });
    should(refusal(runtime(), undefined, missing)).match({
      code: 'cli_missing',
      message: /Claude Code is not installed/u,
    });
  });

  it('should refuse a login over its budget, naming the worse period and when it is back', () => {
    const over = (budget: FleetCredentialView['budget']) => facts({ credentials: [credential({ budget })] });
    const soft = refusal(
      runtime(),
      undefined,
      over({
        level: 'over_trigger',
        daily: { level: 'over_trigger', trigger: 40, spentUsd: 41.2, resetsAt: '2026-10-31T07:00:00.000Z' },
        weekly: { level: 'ok', spentUsd: 1, resetsAt: 'x' },
      }),
    );
    should(soft).match({ code: 'over_budget', message: /spent \$41\.20 of its \$40\.00 daily trigger/u });
    const hard = refusal(
      runtime(),
      undefined,
      over({
        level: 'over_hard',
        weekly: { level: 'over_hard', hard: 100, spentUsd: 120, resetsAt: '2026-11-03T00:00:00.000Z' },
        daily: { level: 'over_trigger', trigger: 10, spentUsd: 11, resetsAt: 'x' },
      }),
    );
    should(hard).match({ code: 'over_budget', message: /\$120\.00 of its \$100\.00 weekly hard limit/u });
    should(refusal(runtime(), undefined, over({ level: 'ok' }))).be.undefined();
    should(refusal(runtime(), undefined, over({ level: 'over_trigger' }))).be.undefined();
  });

  it('should refuse a runtime its launcher cannot start, and one that is disabled', () => {
    should(refusal(runtime(), undefined, facts({ unlaunchable: { 'claude-auto-a': 'no launcher' } }))).match({
      code: 'cli_missing',
      message: /cannot be launched: no launcher/u,
    });
    should(refusal(runtime({ disabled: { by: 'owner' } }), undefined, facts())).match({
      code: 'disabled',
      message: /it is disabled/u,
    });
    should(
      refusal(runtime({ disabled: {}, launch: { available: false, reason: 'paused' } }), undefined, facts()),
    ).match({ code: 'disabled', message: /paused/u });
  });

  it('should refuse a login that lacks secrets or needs signing in', () => {
    const lacking = facts({ credentials: [credential({ environment: { missingSecrets: ['KEY_A', 'KEY_B'] } })] });
    should(refusal(runtime(), undefined, lacking)).match({ code: 'not_logged_in', message: /KEY_A, KEY_B/u });
    const signedOut = facts({ credentials: [credential({ status: { word: 'needs_sign_in' } })] });
    should(refusal(runtime(), undefined, signedOut)).match({ code: 'not_logged_in', message: /needs signing in/u });
    const unknownLogin = facts({ credentials: [] });
    should(refusal(runtime({ credential: { id: 'login-a', status: 'needs_sign_in' } }), undefined, unknownLogin)).match(
      {
        code: 'not_logged_in',
      },
    );
  });

  it('should refuse a login out of quota, including by a limit a pane proved', () => {
    const spent = facts({
      credentials: [credential({ usage: { fiveHour: { usedPercent: 100 }, weekly: {} } })],
    });
    should(refusal(runtime(), undefined, spent)).match({ code: 'out_of_quota' });
    const paneLimits = new Map([['login-a', { notice: 'n', spend: true }]]);
    should(refusal(runtime(), undefined, facts({ paneLimits }))).match({ code: 'out_of_quota' });
  });

  it('should refuse a runtime that cannot launch for a reason of its own', () => {
    should(refusal(runtime({ launch: { available: false, reason: 'Sign in to launch' } }), undefined, facts())).match({
      code: 'not_logged_in',
      message: /Sign in to launch/u,
    });
  });

  it('should refuse a model the runtime does not offer, by its catalog or its model set', () => {
    const catalog = runtime({
      models: { choices: [{ id: 'opus' }], catalog: { id: 'anthropic', customIds: false } },
    });
    should(refusal(catalog, 'opus', facts())).be.undefined();
    should(refusal(catalog, 'haiku', facts())).match({ code: 'model_unavailable' });
    const custom = runtime({ models: { choices: [], catalog: { id: 'zai', customIds: true } } });
    should(refusal(custom, 'anything', facts())).be.undefined();
    const set = runtime({
      modelSet: {
        source: 'model-set',
        models: [
          { id: 'opus', available: true },
          { id: 'haiku', available: false },
        ],
      },
    });
    should(refusal(set, 'opus', facts())).be.undefined();
    should(refusal(set, 'haiku', facts())).match({ code: 'model_unavailable' });
    should(refusal(runtime(), 'opus', facts())).match({ code: 'model_unavailable' });
    should(refusal(runtime({ modelSet: { source: 'model-set' } }), 'opus', facts())).match({
      code: 'model_unavailable',
    });
  });
});
