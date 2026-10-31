import { describe, it } from 'bun:test';
import { type AccountModelDocument, type BudgetHold, type FleetManifest, parseAccountModel } from '@ferretry/fleet';
import should from 'should';
import { budgetAlternative, budgetedLogins } from '../../../src/lib/budget/state.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOLD: BudgetHold = {
  period: 'daily',
  level: 'over_trigger',
  limitUsd: 40,
  resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
  timeZone: 'UTC',
};

const model = (homeDisabled = false) =>
  parseAccountModel({
    version: 2,
    credentials: {
      liftoff: { harness: 'claude', store: 'ferretry', budget: { daily: { trigger: 40 } } },
      home: { harness: 'claude', store: 'host', ...(homeDisabled ? { disabled: {} } : {}) },
      work: { harness: 'claude', store: 'ferretry' },
      codex: { harness: 'codex', store: 'ferretry', budget: { weekly: { hard: 100 } } },
    },
    components: {
      modelSets: {
        claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
        codex: { models: ['gpt-6'], default: 'gpt-6' },
      },
    },
    profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
    runtimes: {
      'claude-liftoff': { credential: 'liftoff', profile: 'default', agent: true },
      'claude-liftoff-term': { credential: 'liftoff', profile: 'default' },
      'claude-home': { credential: 'home', profile: 'default', agent: true },
      'claude-work': { credential: 'work', profile: 'default', agent: true },
      'codex-a': { credential: 'codex', profile: 'default', agent: true },
    },
  } satisfies AccountModelDocument);

describe('budgetedLogins', () => {
  it('should list only logins with a budget, with the runtimes the manifest publishes on each', () => {
    const manifest = {
      runtimes: [
        { credential: 'liftoff', wrapper: '/fy/fleet/bin/claude-liftoff' },
        { credential: 'liftoff', wrapper: '/fy/fleet/bin/claude-liftoff-term' },
        { credential: 'home', wrapper: '/fy/fleet/bin/claude-home' },
      ],
    } as unknown as FleetManifest;
    should(budgetedLogins(model(), manifest)).eql([
      { id: 'codex', budget: { weekly: { hard: 100 } }, agents: [] },
      { id: 'liftoff', budget: { daily: { trigger: 40 } }, agents: ['claude-liftoff', 'claude-liftoff-term'] },
    ]);
    should(budgetedLogins(model(), undefined).map(login => login.agents)).eql([[], []]);
  });
});

describe('budgetAlternative', () => {
  it('should suggest an agent runtime of the same kind on a login that is on and not held', () => {
    should(budgetAlternative(model(), 'liftoff', NOW, { liftoff: HOLD })).equal('claude-home');
    should(budgetAlternative(model(true), 'liftoff', NOW, { liftoff: HOLD })).equal('claude-work');
    should(budgetAlternative(model(true), 'liftoff', NOW, { liftoff: HOLD, work: HOLD })).be.undefined();
    should(budgetAlternative(model(), 'codex', NOW, {})).be.undefined();
  });
});
