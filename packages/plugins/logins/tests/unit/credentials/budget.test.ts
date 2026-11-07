import { describe, it } from 'bun:test';
import should from 'should';
import { LoginFileSchema } from '../../../contract/index.ts';
import {
  type BudgetHold,
  BudgetLimitSchema,
  BudgetSchema,
  budgetHoldPhrase,
  budgetLevel,
  budgetResetWords,
  budgetSpan,
  isTimeZone,
  periodHold,
  strongerHold,
  TimeZoneSchema,
  worseBudgetLevel,
} from '../../../daemon/lib/shared/budget.ts';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('BudgetSchema', () => {
  it('should read either level of either period', () => {
    should(BudgetSchema.parse({ daily: { trigger: 40, hard: 60 }, weekly: { hard: 200 } })).eql({
      daily: { trigger: 40, hard: 60 },
      weekly: { hard: 200 },
    });
    should(BudgetSchema.parse({ weekly: { trigger: 150 } })).eql({ weekly: { trigger: 150 } });
    should(BudgetLimitSchema.parse({ trigger: 50, hard: 50 })).eql({ trigger: 50, hard: 50 });
  });

  it('should refuse a hard limit below its trigger, at the hard limit', () => {
    const parsed = BudgetSchema.safeParse({ daily: { trigger: 60, hard: 40 } });
    should(parsed.success).be.false();
    should(parsed.error?.issues[0]?.path).eql(['daily', 'hard']);
    should(parsed.error?.issues[0]?.message).equal('the hard limit ($40) must not be below the trigger ($60)');
  });

  it('should refuse an empty period, an empty budget, a non-positive amount and an unknown key', () => {
    should(BudgetSchema.safeParse({ daily: {} }).success).be.false();
    should(BudgetSchema.safeParse({}).success).be.false();
    should(BudgetSchema.safeParse({ daily: { trigger: 0 } }).success).be.false();
    should(BudgetSchema.safeParse({ daily: { trigger: -5 } }).success).be.false();
    should(BudgetSchema.safeParse({ monthly: { trigger: 5 } }).success).be.false();
    should(BudgetSchema.safeParse({ daily: { soft: 5 } }).success).be.false();
  });

  it('should be accepted on a sign-in login as well as an environment one', () => {
    should(
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'ferretry', budget: { daily: { trigger: 40 } } }).success,
    ).be.true();
    should(
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'ferretry', budget: { daily: {} } }).success,
    ).be.false();
  });
});

describe('TimeZoneSchema', () => {
  it('should take an IANA zone and refuse anything else', () => {
    should(isTimeZone('America/Los_Angeles')).be.true();
    should(isTimeZone('UTC')).be.true();
    should(isTimeZone('Mars/Olympus')).be.false();
    should(TimeZoneSchema.safeParse('Asia/Singapore').success).be.true();
    should(TimeZoneSchema.safeParse('GMT-7 please').success).be.false();
  });
});

describe('budgetSpan', () => {
  it('should run a UTC day from midnight to midnight', () => {
    const span = budgetSpan('daily', Date.parse('2026-10-30T15:20:00Z'), 'UTC');
    should(iso(span.startMs)).equal('2026-10-30T00:00:00.000Z');
    should(iso(span.endMs)).equal('2026-10-31T00:00:00.000Z');
  });

  it("should run a day from the owner's local midnight, not the host's", () => {
    // 05:00 UTC on Friday is 22:00 on Thursday in Los Angeles (UTC-7 in October).
    const span = budgetSpan('daily', Date.parse('2026-10-30T05:00:00Z'), 'America/Los_Angeles');
    should(iso(span.startMs)).equal('2026-10-29T07:00:00.000Z');
    should(iso(span.endMs)).equal('2026-10-30T07:00:00.000Z');
    const singapore = budgetSpan('daily', Date.parse('2026-10-30T17:00:00Z'), 'Asia/Singapore');
    should(iso(singapore.startMs)).equal('2026-10-30T16:00:00.000Z');
  });

  it('should start a week on Monday 00:00 local, Sunday included in the week before', () => {
    // Friday 2026-10-30.
    const friday = budgetSpan('weekly', Date.parse('2026-10-30T12:00:00Z'), 'UTC');
    should(iso(friday.startMs)).equal('2026-10-26T00:00:00.000Z');
    should(iso(friday.endMs)).equal('2026-11-02T00:00:00.000Z');
    // Sunday 2026-11-01 late evening, and Monday 00:00 exactly.
    should(iso(budgetSpan('weekly', Date.parse('2026-11-01T23:59:59Z'), 'UTC').startMs)).equal(
      '2026-10-26T00:00:00.000Z',
    );
    should(iso(budgetSpan('weekly', Date.parse('2026-11-02T00:00:00Z'), 'UTC').startMs)).equal(
      '2026-11-02T00:00:00.000Z',
    );
  });

  it('should give a day a clock change shortens or lengthens its real length', () => {
    // New York springs forward on 2026-03-08 (23 hours) and falls back on 2026-11-01 (25 hours).
    const spring = budgetSpan('daily', Date.parse('2026-03-08T18:00:00Z'), 'America/New_York');
    should(iso(spring.startMs)).equal('2026-03-08T05:00:00.000Z');
    should((spring.endMs - spring.startMs) / 3_600_000).equal(23);
    const fall = budgetSpan('daily', Date.parse('2026-11-01T18:00:00Z'), 'America/New_York');
    should(iso(fall.startMs)).equal('2026-11-01T04:00:00.000Z');
    should((fall.endMs - fall.startMs) / 3_600_000).equal(25);
    // The week that holds the fall-back Sunday is 7 days and an hour.
    const week = budgetSpan('weekly', Date.parse('2026-10-28T12:00:00Z'), 'America/New_York');
    should((week.endMs - week.startMs) / 3_600_000).equal(7 * 24 + 1);
  });

  it('should start a day at its first instant where midnight itself is skipped', () => {
    // Chile springs forward at 24:00 on Saturday 2026-09-05: Sunday has no 00:00, it starts at 01:00 (UTC-3).
    const span = budgetSpan('daily', Date.parse('2026-09-06T15:00:00Z'), 'America/Santiago');
    should(iso(span.startMs)).equal('2026-09-06T04:00:00.000Z');
  });
});

describe('budget levels and holds', () => {
  const span = { startMs: Date.parse('2026-10-30T00:00:00Z'), endMs: Date.parse('2026-10-31T00:00:00Z') };

  it('should count reaching a limit exactly as being over it', () => {
    should(budgetLevel({ trigger: 40, hard: 60 }, 39.99)).equal('ok');
    should(budgetLevel({ trigger: 40, hard: 60 }, 40)).equal('over_trigger');
    should(budgetLevel({ trigger: 40, hard: 60 }, 60)).equal('over_hard');
    should(budgetLevel({ hard: 60 }, 59)).equal('ok');
    should(budgetLevel({ trigger: 40 }, 1_000)).equal('over_trigger');
    should(worseBudgetLevel('ok', 'over_trigger')).equal('over_trigger');
    should(worseBudgetLevel('over_hard', 'over_trigger')).equal('over_hard');
  });

  it('should hold with the limit reached and the reset, and carry no running amount', () => {
    should(periodHold('daily', { trigger: 40, hard: 60 }, 12, span, 'UTC')).be.undefined();
    const hold = periodHold('daily', { trigger: 40, hard: 60 }, 41.2, span, 'UTC') as BudgetHold;
    should(hold).eql({ period: 'daily', level: 'over_trigger', limitUsd: 40, resetsAtMs: span.endMs, timeZone: 'UTC' });
    should(budgetHoldPhrase(hold)).equal(
      'over its daily budget on this machine (its $40.00 trigger) until Sat 00:00 (UTC)',
    );
    const hard = periodHold('daily', { trigger: 40, hard: 60 }, 75, span, 'UTC') as BudgetHold;
    should(budgetHoldPhrase(hard)).match(/its \$60\.00 hard limit/u);
  });

  it('should let the worse hold speak, and the longer one on a tie', () => {
    const daily: BudgetHold = { period: 'daily', level: 'over_trigger', limitUsd: 40, resetsAtMs: 1, timeZone: 'UTC' };
    const weekly: BudgetHold = {
      period: 'weekly',
      level: 'over_trigger',
      limitUsd: 150,
      resetsAtMs: 5,
      timeZone: 'UTC',
    };
    const hard: BudgetHold = { ...daily, level: 'over_hard', limitUsd: 60 };
    should(strongerHold(undefined, daily)).equal(daily);
    should(strongerHold(daily, weekly)).equal(weekly);
    should(strongerHold(weekly, hard)).equal(hard);
  });

  it('should name a reset in the zone the budget counts in', () => {
    should(budgetResetWords(Date.parse('2026-10-31T07:00:00Z'), 'America/Los_Angeles')).equal(
      'Sat 00:00 (America/Los_Angeles)',
    );
  });
});
