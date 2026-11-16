import { describe, it } from 'bun:test';
import should from 'should';
import { type BudgetHold, BudgetSchema, budgetHoldPhrase, TimeZoneSchema } from '../../../daemon/lib/account/budget.ts';

describe('BudgetSchema', () => {
  it('should read either level of either period', () => {
    should(BudgetSchema.parse({ daily: { trigger: 40, hard: 60 }, weekly: { hard: 200 } })).eql({
      daily: { trigger: 40, hard: 60 },
      weekly: { hard: 200 },
    });
    should(BudgetSchema.parse({ weekly: { trigger: 150 } })).eql({ weekly: { trigger: 150 } });
    should(BudgetSchema.parse({ daily: { trigger: 50, hard: 50 } })).eql({ daily: { trigger: 50, hard: 50 } });
  });

  it('should refuse a hard limit below its trigger, at the hard limit', () => {
    const refused = BudgetSchema.safeParse({ daily: { trigger: 60, hard: 40 } });
    should(refused.success).be.false();
    if (!refused.success) should(refused.error.issues[0]?.path).eql(['daily', 'hard']);
  });

  it('should refuse an empty period, an empty budget, a non-positive amount and an unknown key', () => {
    should(BudgetSchema.safeParse({ daily: {} }).success).be.false();
    should(BudgetSchema.safeParse({}).success).be.false();
    should(BudgetSchema.safeParse({ daily: { trigger: 0 } }).success).be.false();
    should(BudgetSchema.safeParse({ daily: { trigger: -5 } }).success).be.false();
    should(BudgetSchema.safeParse({ monthly: { trigger: 5 } }).success).be.false();
    should(BudgetSchema.safeParse({ daily: { soft: 5 } }).success).be.false();
  });
});

describe('TimeZoneSchema', () => {
  it('should take an IANA zone and refuse anything else', () => {
    should(TimeZoneSchema.safeParse('America/Los_Angeles').success).be.true();
    should(TimeZoneSchema.safeParse('UTC').success).be.true();
    should(TimeZoneSchema.safeParse('Mars/Olympus').success).be.false();
    should(TimeZoneSchema.safeParse('Asia/Singapore').success).be.true();
    should(TimeZoneSchema.safeParse('GMT-7 please').success).be.false();
  });
});

describe('budgetHoldPhrase', () => {
  const resetsAtMs = Date.parse('2026-10-31T00:00:00Z');

  it('should name the limit reached and the reset, and carry no running amount', () => {
    const trigger: BudgetHold = { period: 'daily', level: 'over_trigger', limitUsd: 40, resetsAtMs, timeZone: 'UTC' };
    should(budgetHoldPhrase(trigger)).equal(
      'over its daily budget on this machine (its $40.00 trigger) until Sat 00:00 (UTC)',
    );
    should(budgetHoldPhrase({ ...trigger, level: 'over_hard', limitUsd: 60 })).match(/its \$60\.00 hard limit/u);
  });

  it('should name a reset in the zone the budget counts in', () => {
    const hold: BudgetHold = {
      period: 'weekly',
      level: 'over_trigger',
      limitUsd: 150,
      resetsAtMs: Date.parse('2026-10-31T07:00:00Z'),
      timeZone: 'America/Los_Angeles',
    };
    should(budgetHoldPhrase(hold)).match(/until Sat 00:00 \(America\/Los_Angeles\)$/u);
  });
});
