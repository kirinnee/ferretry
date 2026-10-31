import { describe, it } from 'bun:test';
import should from 'should';
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
} from '../../src/lib/account/budget.ts';
import { runtimeDisable, switchedOff } from '../../src/lib/account/disabled-runtime.ts';
import { EMPTY_RUNTIME_IDS } from '../../src/lib/account/ids.ts';
import { materialiseFleet } from '../../src/lib/account/materialise.ts';
import { type AccountModelDocument, CredentialSchema, parseAccountModel } from '../../src/lib/account/schema.ts';
import { evaluateConfigFiles } from '../../src/lib/config-files/evaluate.ts';
import { setConfigKey } from '../../src/lib/config-files/yaml-text.ts';
import {
  configLoosening,
  loginLoosening,
  runtimeLoosening,
  SINGLETON_DEFAULTS,
} from '../../src/lib/config-files/kinds.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';

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
      CredentialSchema.safeParse({ harness: 'claude', store: 'ferretry', budget: { daily: { trigger: 40 } } }).success,
    ).be.true();
    should(
      CredentialSchema.safeParse({ harness: 'claude', store: 'ferretry', budget: { daily: {} } }).success,
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

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOLD: BudgetHold = {
  period: 'daily',
  level: 'over_trigger',
  limitUsd: 40,
  resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
  timeZone: 'UTC',
};

const model = () =>
  parseAccountModel({
    version: 2,
    credentials: {
      liftoff: { harness: 'claude', store: 'ferretry', budget: { daily: { trigger: 40 } } },
      home: { harness: 'claude', store: 'host' },
    },
    components: { modelSets: { claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } } },
    profiles: { default: { layers: ['modelSets/claude'] } },
    runtimes: {
      'claude-liftoff': { credential: 'liftoff', profile: 'default', agent: true },
      'claude-home': { credential: 'home', profile: 'default', agent: true },
    },
  } satisfies AccountModelDocument);

describe('runtimeDisable with a budget hold', () => {
  it('should hold every runtime on the login, point at another and say how to move a ferret', () => {
    const off = runtimeDisable(model(), 'claude-liftoff', NOW, 'fy', { liftoff: HOLD });
    should(off?.budget).eql(HOLD);
    should(off?.own).be.undefined();
    should(off?.login).be.undefined();
    should(off?.alternative).equal('claude-home');
    should(off?.clauses).eql([
      'its login "liftoff" is over its daily budget on this machine (its $40.00 trigger) until Sat 00:00 (UTC)',
      'Use "claude-home" instead, or raise the login\'s budget. Ferrets already on it keep running; move one with `fy migrate <id> -a claude-home`',
    ]);
  });

  it('should leave a login nothing holds alone, and skip a held alternative', () => {
    should(runtimeDisable(model(), 'claude-liftoff', NOW, 'fy')).be.undefined();
    should(runtimeDisable(model(), 'claude-home', NOW, 'fy', { liftoff: HOLD })).be.undefined();
    const both = runtimeDisable(model(), 'claude-liftoff', NOW, 'fy', { liftoff: HOLD, home: HOLD });
    should(both?.alternative).be.undefined();
    should(switchedOff(model(), model().runtimes['claude-home'] as never, NOW, { home: HOLD })).be.true();
  });

  it('should publish the held runtimes unavailable, with the same reason at every tick', () => {
    const layout: FleetLayout = {
      stateHome: '/fy',
      userHome: '/home/person',
      fleetDirectory: '/fy/fleet',
      binDirectory: '/fy/fleet/bin',
      homesDirectory: '/fy/fleet/homes',
      assetsDirectory: '/fy/fleet/assets',
      manifestPath: '/fy/fleet/manifest.json',
      defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
    };
    const publish = () =>
      materialiseFleet({
        model: model(),
        layout,
        ids: EMPTY_RUNTIME_IDS,
        mint: (() => {
          let n = 0;
          return () => {
            n += 1;
            return `00000000-0000-4000-8000-00000000000${n}`;
          };
        })(),
        generatedAt: iso(NOW),
        claudeStatusline: () => "'fy' statusline",
        fyCommand: '/opt/ferretry/bin/fy',
        hostCodexHome: '/home/person/.codex',
        acceptsAutoPermissionMode: true,
        budgetHolds: { liftoff: HOLD },
      });
    const first = publish();
    const row = first.manifest.accounts.find(account => account.displayName === 'claude-liftoff');
    should(row).match({ available: false });
    should(row?.unavailableReason).match(/over its daily budget on this machine/u);
    should(first.manifest.accounts.find(account => account.displayName === 'claude-home')).match({ available: true });
    should(publish().manifest.accounts).eql(first.manifest.accounts);
  });
});

describe('loginLoosening', () => {
  const login = (budget?: object) =>
    CredentialSchema.parse({ harness: 'claude', store: 'ferretry', ...(budget ? { budget } : {}) });

  it('should hold a limit raised or removed, and a budget dropped', () => {
    const before = login({ daily: { trigger: 40, hard: 60 }, weekly: { trigger: 150 } });
    should(
      loginLoosening('liftoff', before, login({ daily: { trigger: 50, hard: 60 }, weekly: { trigger: 150 } })),
    ).eql(['login "liftoff"\'s daily trigger in dollars goes up from 40 to 50']);
    should(loginLoosening('liftoff', before, login({ daily: { trigger: 40 }, weekly: { trigger: 150 } }))).eql([
      'login "liftoff"\'s daily hard limit in dollars is removed (was 60)',
    ]);
    should(loginLoosening('liftoff', before, login())).have.length(3);
  });

  it('should let a limit added or lowered, and a new login, through — and hold a budgeted login deleted', () => {
    const before = login({ daily: { trigger: 40, hard: 60 } });
    should(loginLoosening('liftoff', before, login({ daily: { trigger: 30, hard: 60 }, weekly: { hard: 100 } }))).eql(
      [],
    );
    should(loginLoosening('liftoff', login(), login({ daily: { trigger: 30 } }))).eql([]);
    should(loginLoosening('liftoff', undefined, login({ daily: { trigger: 900 } }))).eql([]);
    should(loginLoosening('liftoff', before, undefined)).eql([
      'login "liftoff"\'s daily trigger in dollars is removed (was 40)',
      'login "liftoff"\'s daily hard limit in dollars is removed (was 60)',
    ]);
  });
});

describe('machine timeZone loosening', () => {
  const machine = (timeZone?: string) => ({
    ...SINGLETON_DEFAULTS.machine,
    machine: { ...SINGLETON_DEFAULTS.machine.machine, ...(timeZone === undefined ? {} : { timeZone }) },
  });

  it('should hold every zone change: the first one set, one changed and one removed', () => {
    should(configLoosening('machine', machine(), machine('America/Los_Angeles'))).eql([
      "budgets now reset in America/Los_Angeles instead of the host's time zone",
    ]);
    should(configLoosening('machine', machine('UTC'), machine('UTC'))).eql([]);
    should(configLoosening('machine', machine('America/Los_Angeles'), machine('Asia/Singapore'))).eql([
      'budgets now reset in Asia/Singapore instead of America/Los_Angeles',
    ]);
    should(configLoosening('machine', machine('UTC'), machine())).eql([
      "budgets now reset in the host's time zone instead of UTC",
    ]);
  });
});

describe('a first time zone cannot clear a day that is over budget (security regression)', () => {
  it('should hold machine.yaml setting its first timeZone, keeping the host zone in effect', () => {
    // A daily budget spent on a UTC host; an agent writes a zone where the next day has already begun.
    // Before the fix the first zone applied at once, the day reset, and the over-budget hold lifted.
    const digest = (text: string): string => String(Bun.hash(text));
    const evaluated = evaluateConfigFiles({
      files: [{ path: 'machine.yaml', text: 'timeZone: Pacific/Kiritimati\n' }],
      accepted: {},
      digest,
    });
    should(evaluated.pending.map(item => item.path)).eql(['machine.yaml']);
    should(evaluated.pending[0]?.changes).eql([
      "budgets now reset in Pacific/Kiritimati instead of the host's time zone",
    ]);
    should(evaluated.effective.model.machine.timeZone).be.undefined();
    // The day boundary the meter counts in is therefore unchanged: a UTC day, not Kiritimati's (UTC+14).
    const now = Date.parse('2026-10-30T12:00:00Z');
    should(budgetSpan('daily', now, evaluated.effective.model.machine.timeZone ?? 'UTC').startMs).equal(
      Date.parse('2026-10-30T00:00:00Z'),
    );
  });
});

describe('evaluateConfigFiles with a login budget', () => {
  const digest = (text: string): string => String(Bun.hash(text));
  const file = (budget: string) => `harness: claude\nstore: ferretry\n${budget}`;

  it('should hold a raised budget and keep the tighter one in effect, and apply a lowered one', () => {
    const tight = file('budget:\n  daily:\n    trigger: 40\n');
    const accepted = { 'logins/liftoff.yaml': { etag: digest(tight), text: tight } };
    const raised = evaluateConfigFiles({
      files: [{ path: 'logins/liftoff.yaml', text: file('budget:\n  daily:\n    trigger: 400\n') }],
      accepted,
      digest,
    });
    should(raised.pending.map(item => item.path)).eql(['logins/liftoff.yaml']);
    should(raised.pending[0]?.changes).eql(['login "liftoff"\'s daily trigger in dollars goes up from 40 to 400']);
    should(raised.effective.model.credentials.liftoff?.budget).eql({ daily: { trigger: 40 } });

    const lowered = evaluateConfigFiles({
      files: [{ path: 'logins/liftoff.yaml', text: file('budget:\n  daily:\n    trigger: 20\n') }],
      accepted,
      digest,
    });
    should(lowered.pending).eql([]);
    should(lowered.effective.model.credentials.liftoff?.budget).eql({ daily: { trigger: 20 } });
  });
});

describe('setConfigKey', () => {
  it('should set or remove one key and keep every other key and comment', () => {
    const text = '# my login\nharness: claude # the CLI\nstore: ferretry\n';
    should(setConfigKey(text, 'budget', { daily: { trigger: 40 } })).equal(
      '# my login\nharness: claude # the CLI\nstore: ferretry\nbudget:\n  daily:\n    trigger: 40\n',
    );
    should(setConfigKey(`${text}budget:\n  daily:\n    trigger: 40\n`, 'budget', undefined)).equal(text);
    should(setConfigKey('', 'timeZone', 'UTC')).equal('timeZone: UTC\n');
  });

  it('should refuse a file that does not parse or is not a mapping, rather than overwrite it', () => {
    should(() => setConfigKey('harness: [claude\n', 'budget', {})).throw(/the file does not parse/u);
    should(() => setConfigKey('- just\n- a list\n', 'budget', {})).throw('the file is not a mapping of keys');
  });
});

describe('a budget cannot be removed by deleting or re-pointing (owner-gate regression)', () => {
  const digest = (text: string): string => String(Bun.hash(text));
  const LIFTOFF = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    hard: 60\n';
  const BARE = 'harness: claude\nstore: ferretry\n';
  const HOME = 'harness: claude\nstore: host\n';
  const PROFILE = 'contents: []\n';
  const ON_LIFTOFF = 'credential: liftoff\nprofile: default\nagent: true\n';
  const ON_HOME = 'credential: home\nprofile: default\nagent: true\n';
  const fleet = {
    'logins/liftoff.yaml': LIFTOFF,
    'logins/home.yaml': HOME,
    'profiles/default.yaml': PROFILE,
    'runtimes/claude-liftoff.yaml': ON_LIFTOFF,
  } as const;
  const accepted = Object.fromEntries(
    Object.entries(fleet).map(([path, text]) => [path, { etag: digest(text), text }]),
  );
  const evaluate = (files: Record<string, string>) =>
    evaluateConfigFiles({
      files: Object.entries(files).map(([path, text]) => ({ path, text })),
      accepted,
      digest,
    });

  it('should hold deleting a budgeted login together with its runtime, keeping both in effect', () => {
    const { 'logins/liftoff.yaml': _login, 'runtimes/claude-liftoff.yaml': _runtime, ...rest } = fleet;
    const evaluated = evaluate(rest);
    should(evaluated.pending.map(item => item.path).toSorted()).eql([
      'logins/liftoff.yaml',
      'runtimes/claude-liftoff.yaml',
    ]);
    should(evaluated.pending.find(item => item.path === 'logins/liftoff.yaml')?.changes).eql([
      'login "liftoff"\'s daily hard limit in dollars is removed (was 60)',
    ]);
    should(evaluated.effective.model.credentials.liftoff?.budget).eql({ daily: { hard: 60 } });
    should(evaluated.effective.model.runtimes['claude-liftoff']?.credential).equal('liftoff');
  });

  it('should judge a login made again without its budget against the one in effect, and hold it', () => {
    const evaluated = evaluate({ ...fleet, 'logins/liftoff.yaml': BARE });
    should(evaluated.pending.map(item => item.path)).eql(['logins/liftoff.yaml']);
    should(evaluated.effective.model.credentials.liftoff?.budget).eql({ daily: { hard: 60 } });
  });

  it('should hold a runtime re-pointed off a budgeted login, or deleted off it', () => {
    const moved = evaluate({ ...fleet, 'runtimes/claude-liftoff.yaml': ON_HOME });
    should(moved.pending.map(item => item.changes)).eql([
      ['runtime "claude-liftoff" moves off login "liftoff", whose budget counts and stops it, to "home"'],
    ]);
    should(moved.effective.model.runtimes['claude-liftoff']?.credential).equal('liftoff');
    const { 'runtimes/claude-liftoff.yaml': _runtime, ...withoutRuntime } = fleet;
    should(evaluate(withoutRuntime).pending.map(item => item.changes)).eql([
      ['runtime "claude-liftoff" is removed from login "liftoff", whose budget counts and stops it'],
    ]);
  });

  it('should let a login with no budget, or a runtime off one, be deleted or re-pointed at once', () => {
    const { 'logins/home.yaml': _home, ...withoutHome } = fleet;
    should(evaluate(withoutHome).pending).eql([]);
    should(evaluate({ ...fleet, 'runtimes/claude-home.yaml': ON_HOME }).pending).eql([]);
    should(loginLoosening('home', { budget: undefined }, undefined)).eql([]);
    should(runtimeLoosening('r', { credential: 'home' }, { credential: 'liftoff' }, login => login === 'liftoff')).eql(
      [],
    );
  });
});
