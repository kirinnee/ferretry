import { describe, it } from 'bun:test';
import type { Pause } from '../../../contract/index.ts';
import should from 'should';
import { budgetAlternative, budgetedLogins, holdsKey } from '../../../daemon/lib/budget/state.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOLD: Pause = {
  period: 'daily',
  level: 'over_trigger',
  limitUsd: 40,
  resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
  timeZone: 'UTC',
};

describe('budgetedLogins', () => {
  it('should list the logins that have a budget in id order, each metered under its own id', () => {
    should(budgetedLogins({ liftoff: { daily: { trigger: 40 } }, codex: { weekly: { hard: 100 } } })).eql([
      { id: 'codex', budget: { weekly: { hard: 100 } }, agents: ['codex'] },
      { id: 'liftoff', budget: { daily: { trigger: 40 } }, agents: ['liftoff'] },
    ]);
    should(budgetedLogins({})).eql([]);
  });
});

describe('budgetAlternative', () => {
  it('should suggest another login that is on and not held, in id order', () => {
    should(budgetAlternative(['work', 'liftoff', 'home'], 'liftoff', NOW, { liftoff: HOLD })).equal('home');
    should(budgetAlternative(['work', 'liftoff', 'home'], 'liftoff', NOW, { liftoff: HOLD, home: HOLD })).equal('work');
    should(budgetAlternative(['liftoff'], 'liftoff', NOW, {})).be.undefined();
  });

  it('should pass over a login whose pause has already reset', () => {
    const lapsed: Pause = { ...HOLD, resetsAtMs: Date.parse('2026-10-30T00:00:00Z') };
    should(budgetAlternative(['home', 'liftoff'], 'liftoff', NOW, { home: lapsed })).equal('home');
  });
});

describe('holdsKey', () => {
  it('should be the same for the same holds in any order, and differ when a hold moves', () => {
    const other: Pause = { ...HOLD, level: 'over_hard' };
    should(holdsKey({ a: HOLD, b: other })).equal(holdsKey({ b: other, a: HOLD }));
    should(holdsKey({ a: HOLD })).not.equal(holdsKey({ a: other }));
  });
});
