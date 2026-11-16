import { describe, expect, it } from 'bun:test';
import type { LoginBudget } from '../../../contract/index.ts';
import { budgetZoneWords } from '../../../app/lib/budget-model.ts';

const budget = (over: Partial<LoginBudget>): LoginBudget => ({
  timeZone: 'Asia/Singapore',
  timeZoneSet: true,
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...over,
});

describe('budgetZoneWords', () => {
  it('should say whose zone the days are counted in once there is no budget yet', () => {
    expect(budgetZoneWords(undefined, 'Europe/London')).toContain('counted in your zone (Europe/London) once you save');
  });

  it('should say the zone usage.yaml names when the file sets one', () => {
    expect(budgetZoneWords(budget({ timeZoneSet: true }), 'Europe/London')).toBe(
      'Days reset at midnight, weeks on Monday, in Asia/Singapore (written in usage.yaml).',
    );
  });

  it('should say it is the machine’s own zone, and what saving here would write, when the file sets none', () => {
    expect(budgetZoneWords(budget({ timeZoneSet: false }), 'Europe/London')).toBe(
      'Days reset at midnight, weeks on Monday, in Asia/Singapore — this machine’s own zone. Saving here writes yours (Europe/London).',
    );
  });
});
