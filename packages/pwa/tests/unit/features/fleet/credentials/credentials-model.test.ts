import { describe, expect, it } from 'bun:test';
import type { FleetBudgetPeriodView, FleetCredentialBudget, FleetCredentialList } from '@ferretry/protocol';
import {
  budgetChip,
  budgetDraft,
  budgetDraftChanged,
  budgetDraftProblem,
  budgetMeterRows,
  budgetOfDraft,
  budgetResetWords,
  budgetScopeNote,
  budgetZoneWords,
  credentialEmail,
  credentialExplanation,
  credentialGroups,
  credentialHarnesses,
  credentialName,
  credentialsOf,
  credentialUse,
  finishSignInLabel,
  HARNESS_COMMANDS,
  HARNESS_SHORT,
  HARNESSES,
  harnessesName,
  hasSharedEmails,
  LOGIN_SCOPE_WORDS,
  labelsError,
  nextCredentialId,
  otherHarness,
  parseBudgetAmount,
  plural,
  sameEmailLogin,
  scopeOfHarnesses,
  signedInSentence,
  signInCoverage,
  slotBadge,
  terminalBadge,
  type UsageBar,
  usageBars,
  usageBarText,
  usdWords,
} from '../../../../../src/features/fleet/credentials/credentials-model.ts';
import { CREDENTIALS, credential, NOW, withStatus } from '../account-support.ts';

const byId = (id: string) => {
  const found = CREDENTIALS.credentials.find(entry => entry.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

const listOf = (...credentials: ReturnType<typeof credential>[]): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials,
});

describe('harness names', () => {
  it('names each harness for a person, a sentence and a terminal', () => {
    expect(HARNESSES).toEqual(['claude', 'codex']);
    expect(HARNESS_SHORT).toEqual({ claude: 'Claude', codex: 'Codex' });
    expect(HARNESS_COMMANDS).toEqual({ claude: 'claude', codex: 'codex' });
  });

  it('finds the other harness', () => {
    expect(otherHarness('claude')).toBe('codex');
    expect(otherHarness('codex')).toBe('claude');
  });

  it('pluralises with the default and a custom plural', () => {
    expect(plural(1, 'runtime')).toBe('1 runtime');
    expect(plural(0, 'runtime')).toBe('0 runtimes');
    expect(plural(3, 'runtime')).toBe('3 runtimes');
    expect(plural(2, 'person', 'people')).toBe('2 people');
    expect(plural(1, 'person', 'people')).toBe('1 person');
  });
});

describe('how a login is named', () => {
  it('uses the email, or says which harness has not told us one', () => {
    expect(credentialEmail(credential({ id: 'a' }))).toBe('you@example.com');
    expect(credentialEmail(credential({ id: 'a', harness: 'claude', email: undefined }))).toBe('Claude Code login');
    expect(credentialEmail(credential({ id: 'a', harness: 'codex', email: undefined }))).toBe('Codex login');
  });

  it('adds the label in brackets when there is one', () => {
    expect(credentialName(credential({ id: 'a', label: 'work' }))).toBe('you@example.com (work)');
    expect(credentialName(credential({ id: 'a' }))).toBe('you@example.com');
    expect(credentialName(credential({ id: 'a', email: undefined, label: 'work' }))).toBe('Claude Code login (work)');
  });

  it('says how many runtimes use it', () => {
    expect(credentialUse(credential({ id: 'a' }))).toBe('Not used yet');
    expect(credentialUse(credential({ id: 'a', usedBy: ['one'] }))).toBe('Used by 1 runtime');
    expect(credentialUse(credential({ id: 'a', usedBy: ['one', 'two', 'three'] }))).toBe('Used by 3 runtimes');
  });
});

describe('badges', () => {
  it('says a login is shared with the terminal, with that harness command', () => {
    expect(terminalBadge(credential({ id: 'a', sharedWithTerminal: true }))).toBe(
      'Shared with claude in your terminal',
    );
    expect(terminalBadge(credential({ id: 'a', harness: 'codex', sharedWithTerminal: true }))).toBe(
      'Shared with codex in your terminal',
    );
    expect(terminalBadge(credential({ id: 'a' }))).toBeNull();
  });

  it('says where an empty slot was copied from', () => {
    expect(slotBadge(credential({ id: 'a', clonedFrom: 'studio-mac' }))).toBe('Copied slot from studio-mac');
    expect(slotBadge(credential({ id: 'a' }))).toBeNull();
  });
});

describe('credentialExplanation', () => {
  it('explains an empty slot that a clone made', () => {
    expect(
      credentialExplanation(credential({ id: 'a', clonedFrom: 'studio-mac', ...withStatus('needs_sign_in') })),
    ).toBe(
      'Empty slot. It was copied from studio-mac without the login itself. Sign in once and every runtime that uses it can launch.',
    );
  });

  it('otherwise gives the daemon’s own sentence', () => {
    const needsSignIn = credential({ id: 'a', ...withStatus('needs_sign_in') });
    expect(credentialExplanation(needsSignIn)).toBe(needsSignIn.status.explanation);
    const cloned = credential({ id: 'a', clonedFrom: 'studio-mac' });
    expect(credentialExplanation(cloned)).toBe('Ready. Checked a few minutes ago.');
  });
});

describe('sign-in words', () => {
  it('counts the runtimes one sign-in finishes', () => {
    expect(finishSignInLabel(credential({ id: 'a' }))).toBe('Finish sign-in');
    expect(finishSignInLabel(credential({ id: 'a', usedBy: ['one'] }))).toBe('Finish sign-in');
    expect(finishSignInLabel(credential({ id: 'a', usedBy: ['one', 'two', 'three'] }))).toBe(
      'Finish sign-in for 3 runtimes',
    );
  });

  it('says what a sign-in covers on a machine', () => {
    expect(signInCoverage(credential({ id: 'a' }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Nothing uses it yet.',
    );
    expect(signInCoverage(credential({ id: 'a', usedBy: ['one'] }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Every runtime that uses it (1 runtime) can launch once it is done.',
    );
    expect(signInCoverage(credential({ id: 'a', usedBy: ['one', 'two'] }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Every runtime that uses it (2 runtimes) can launch once it is done.',
    );
  });

  it('says how many runtimes can launch after a sign-in', () => {
    expect(signedInSentence(0)).toBe('Signed in.');
    expect(signedInSentence(1)).toBe('Signed in. 1 runtime can launch now.');
    expect(signedInSentence(3)).toBe('Signed in. 3 runtimes can launch now.');
  });
});

describe('usage bars', () => {
  const bars = (usage: ReturnType<typeof credential>['usage']): readonly UsageBar[] | null =>
    usageBars(credential({ id: 'a', usage }), NOW);

  it('draws both windows with whole percents, reset times and a warning at 80%', () => {
    expect(usageBars(byId('claude-personal'), NOW)).toEqual([
      { label: '5h', percent: 38, resets: 'resets in 2h', high: false },
      { label: 'Week', percent: 83, resets: 'resets in 3d', high: true },
    ]);
  });

  it('rounds, caps at 100% and treats exactly 80% as high', () => {
    expect(bars({ fiveHour: { usedPercent: 79.6 }, weekly: { usedPercent: 250 } })).toEqual([
      { label: '5h', percent: 80, resets: null, high: true },
      { label: 'Week', percent: 100, resets: null, high: true },
    ]);
    expect(bars({ fiveHour: { usedPercent: 79.4 }, weekly: { usedPercent: 0 } })).toEqual([
      { label: '5h', percent: 79, resets: null, high: false },
      { label: 'Week', percent: 0, resets: null, high: false },
    ]);
  });

  it('keeps an unmeasured window as "not measured", never as zero', () => {
    expect(bars({ fiveHour: { usedPercent: 10 }, weekly: {} })).toEqual([
      { label: '5h', percent: 10, resets: null, high: false },
      { label: 'Week', percent: null, resets: null, high: false },
    ]);
  });

  it('says "resets now" for a reset that is due', () => {
    expect(
      bars({
        fiveHour: { usedPercent: 50, resetsAt: '2026-10-13T07:00:00.000Z' },
        weekly: { usedPercent: 50, resetsAt: 'not a date' },
      }),
    ).toEqual([
      { label: '5h', percent: 50, resets: 'resets now', high: false },
      { label: 'Week', percent: 50, resets: null, high: false },
    ]);
  });

  it('returns nothing when neither window was measured', () => {
    expect(bars({ fiveHour: {}, weekly: {} })).toBeNull();
    expect(usageBars(byId('codex'), NOW)).toBeNull();
  });

  it('words each bar so its direction cannot be misread', () => {
    expect(usageBarText({ label: '5h', percent: null, resets: null, high: false })).toBe('5h: not measured yet');
    expect(usageBarText({ label: '5h', percent: 38, resets: null, high: false })).toBe('5h: 38% used');
    expect(usageBarText({ label: 'Week', percent: 83, resets: 'resets in 3d', high: true })).toBe(
      'Week: 83% used · resets in 3d',
    );
  });
});

const DUAL = credential({ id: 'deepseek', store: 'environment', email: undefined, harnesses: ['claude', 'codex'] });

describe('a login’s scope', () => {
  it('drives its harnesses, or its one harness from a daemon that predates halves', () => {
    expect(credentialHarnesses(DUAL)).toEqual(['claude', 'codex']);
    expect(credentialHarnesses(credential({ id: 'codex', harness: 'codex' }))).toEqual(['codex']);
  });

  it('says one CLI, or both', () => {
    expect(scopeOfHarnesses(['claude'])).toBe('claude');
    expect(scopeOfHarnesses(['codex'])).toBe('codex');
    expect(scopeOfHarnesses(['codex', 'claude'])).toBe('both');
    expect(scopeOfHarnesses([])).toBe('claude');
    expect(LOGIN_SCOPE_WORDS.both).toBe('Claude + Codex');
    expect(harnessesName(['claude', 'codex'])).toBe('Claude Code + Codex');
    expect(credentialEmail(DUAL)).toBe('Claude Code + Codex login');
  });
});

describe('lists of logins', () => {
  it('filters by harness in the order the daemon listed them', () => {
    expect(credentialsOf(CREDENTIALS, 'claude').map(entry => entry.id)).toEqual(['claude-personal', 'claude-work']);
    expect(credentialsOf(CREDENTIALS, 'codex').map(entry => entry.id)).toEqual(['codex']);
    expect(credentialsOf(listOf(), 'claude')).toEqual([]);
  });

  it('offers a login that drives both CLIs for either', () => {
    const list = listOf(credential({ id: 'claude' }), DUAL, credential({ id: 'codex', harness: 'codex' }));
    expect(credentialsOf(list, 'claude').map(entry => entry.id)).toEqual(['claude', 'deepseek']);
    expect(credentialsOf(list, 'codex').map(entry => entry.id)).toEqual(['deepseek', 'codex']);
  });

  it('groups the tab by CLI and lists a login that drives both once, in its own group', () => {
    const list = listOf(credential({ id: 'claude' }), DUAL, credential({ id: 'codex', harness: 'codex' }));
    expect(credentialGroups(list).map(group => [group.scope, group.title, group.credentials.map(c => c.id)])).toEqual([
      ['claude', 'Claude Code', ['claude']],
      ['codex', 'Codex', ['codex']],
      ['both', 'Claude Code + Codex', ['deepseek']],
    ]);
    expect(credentialGroups(listOf(DUAL)).map(group => group.scope)).toEqual(['both']);
  });

  it('knows when emails are shared, from a flag or from the logins themselves', () => {
    expect(hasSharedEmails(CREDENTIALS)).toBe(true);
    expect(hasSharedEmails(listOf(credential({ id: 'a', needsLabel: true })))).toBe(true);
    expect(
      hasSharedEmails(listOf(credential({ id: 'a', email: 'a@x.test' }), credential({ id: 'b', email: 'b@x.test' }))),
    ).toBe(false);
    expect(
      hasSharedEmails(listOf(credential({ id: 'a', email: undefined }), credential({ id: 'b', email: undefined }))),
    ).toBe(false);
    expect(hasSharedEmails(listOf())).toBe(false);
  });

  it('does not call one email on two harnesses shared', () => {
    expect(
      hasSharedEmails(
        listOf(
          credential({ id: 'a', email: 'a@x.test' }),
          credential({ id: 'b', harness: 'codex', email: 'a@x.test' }),
        ),
      ),
    ).toBe(false);
  });

  it('finds another login of this harness with the same email', () => {
    const one = credential({ id: 'one' });
    const two = credential({ id: 'two' });
    const list = listOf(one, credential({ id: 'cx', harness: 'codex' }), two);
    expect(sameEmailLogin(list, one)?.id).toBe('two');
    expect(sameEmailLogin(listOf(one), one)).toBeUndefined();
    expect(sameEmailLogin(listOf(one, credential({ id: 'cx', harness: 'codex' })), one)).toBeUndefined();
    expect(sameEmailLogin(listOf(one, credential({ id: 'x', email: 'other@x.test' })), one)).toBeUndefined();
    const unknown = credential({ id: 'u', email: undefined });
    expect(sameEmailLogin(listOf(unknown, credential({ id: 'v', email: undefined })), unknown)).toBeUndefined();
  });
});

describe('labelsError', () => {
  it('asks for both labels, and for two different ones', () => {
    expect(labelsError('', 'work')).toBe('Give each login a label.');
    expect(labelsError('home', '   ')).toBe('Give each login a label.');
    expect(labelsError(' work ', 'work')).toBe('Use two different labels.');
    expect(labelsError('home', 'work')).toBeNull();
  });
});

describe('nextCredentialId', () => {
  it('uses the bare harness name when it is free', () => {
    expect(nextCredentialId(null, 'claude')).toBe('claude');
    expect(nextCredentialId(listOf(), 'codex')).toBe('codex');
    expect(nextCredentialId(listOf(credential({ id: 'claude-2' })), 'claude')).toBe('claude');
  });

  it('numbers past every id this machine already has', () => {
    expect(nextCredentialId(listOf(credential({ id: 'claude' })), 'claude')).toBe('claude-2');
    expect(
      nextCredentialId(
        listOf(credential({ id: 'claude' }), credential({ id: 'claude-2' }), credential({ id: 'claude-3' })),
        'claude',
      ),
    ).toBe('claude-4');
    expect(nextCredentialId(CREDENTIALS, 'codex')).toBe('codex-2');
  });
});

// ── Budgets (docs/budgets.md) ─────────────────────────────────────────────────────────────────────

/** America/New_York, EDT: local midnight is 04:00Z, so the reset words are pinned by these instants. */
const period = (overrides: Partial<FleetBudgetPeriodView> = {}): FleetBudgetPeriodView => ({
  trigger: 40,
  hard: 60,
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-10-13T04:00:00.000Z',
  resetsAt: '2026-10-14T04:00:00.000Z',
  ...overrides,
});

const budget = (overrides: Partial<FleetCredentialBudget> = {}): FleetCredentialBudget => ({
  timeZone: 'America/New_York',
  timeZoneSet: true,
  daily: period({ trigger: 40, hard: 60 }),
  weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-10-19T04:00:00.000Z' }),
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...overrides,
});

describe('budget words', () => {
  it('says dollars as a bill reads', () => {
    expect(usdWords(12.4)).toBe('$12.40');
    expect(usdWords(0)).toBe('$0.00');
    expect(usdWords(40)).toBe('$40.00');
  });

  it('says a reset time in the zone the budget is counted in, never the reader’s', () => {
    expect(budgetResetWords('2026-10-14T04:00:00.000Z', 'America/New_York')).toBe('resets Wed');
    expect(budgetResetWords('2026-10-19T04:00:00.000Z', 'America/New_York')).toBe('resets Mon');
    expect(budgetResetWords('2026-10-17T00:00:00.000Z', 'UTC')).toBe('resets Sat');
    expect(budgetResetWords('2026-10-14T09:30:00.000Z', 'UTC')).toBe('resets Wed 09:30');
  });
});

describe('budget meter rows', () => {
  it('draws one row per period on a bar a fifth past the higher limit, so both marks sit inside it', () => {
    expect(budgetMeterRows(budget())).toEqual([
      {
        label: '$/day',
        words: '$12.40 of $40.00 · resets Wed',
        fillPercent: 17,
        triggerPercent: 56,
        hardPercent: 83,
        level: 'ok',
      },
      {
        label: '$/week',
        words: '$150.01 of $200.00 · resets Mon',
        fillPercent: 42,
        triggerPercent: 56,
        hardPercent: 83,
        level: 'ok',
      },
    ]);
  });

  it('scales a period with no trigger by its hard limit and says so', () => {
    const rows = budgetMeterRows(budget({ daily: period({ trigger: undefined, hard: 50, spentUsd: 12.5 }) }));
    expect(rows[0]?.words).toBe('$12.50 of $50.00 hard · resets Wed');
    expect(rows[0]?.fillPercent).toBe(21);
    expect(rows[0]?.triggerPercent).toBeNull();
    expect(rows[0]?.hardPercent).toBe(83);
  });

  it('clamps the fill at the bar’s end and leaves the tick off a period with no hard limit', () => {
    const rows = budgetMeterRows(budget({ daily: period({ trigger: 10, hard: undefined, spentUsd: 99 }) }));
    expect(rows[0]?.fillPercent).toBe(100);
    expect(rows[0]?.triggerPercent).toBe(83);
    expect(rows[0]?.hardPercent).toBeNull();
  });

  it('leaves out a period the budget does not have and carries each period’s level', () => {
    expect(budgetMeterRows(budget({ weekly: undefined, daily: period({ level: 'over_trigger' }) }))).toEqual([
      expect.objectContaining({ label: '$/day', level: 'over_trigger' }),
    ]);
    expect(budgetMeterRows(budget({ daily: undefined }))[0]?.label).toBe('$/week');
  });
});

describe('budget chip', () => {
  it('says what each hold stops, by level', () => {
    expect(budgetChip(undefined)).toBeNull();
    expect(budgetChip(budget())).toBeNull();
    expect(budgetChip(budget({ level: 'over_trigger' }))).toEqual({
      label: 'Over budget — not routing',
      tone: 'warn',
    });
    expect(budgetChip(budget({ level: 'over_hard' }))).toEqual({
      label: 'Hard limit — ferrets stopped',
      tone: 'err',
    });
  });
});

describe('budget scope note', () => {
  it('says the spend is this machine’s only', () => {
    expect(budgetScopeNote(budget(), 'studio-mac')).toBe('Spent on studio-mac only');
  });

  it('counts unpriced requests and an unmeasured meter, never as $0', () => {
    expect(budgetScopeNote(budget({ unpriced: 1, measured: false }), 'studio-mac')).toBe(
      'Spent on studio-mac only · 1 request without a price · Counting…',
    );
    expect(budgetScopeNote(budget({ unpriced: 3 }), 'studio-mac')).toBe(
      'Spent on studio-mac only · 3 requests without a price',
    );
    expect(budgetScopeNote(budget({ measured: false }), 'studio-mac')).toBe('Spent on studio-mac only · Counting…');
  });

  it('says the amount may be low when a transcript could not be read back to the start of the period', () => {
    expect(budgetScopeNote(budget({ partial: true }), 'studio-mac')).toBe(
      'Spent on studio-mac only · may be low: a transcript is too large to read in full',
    );
  });
});

describe('budget zone words', () => {
  it('says where a budget’s zone comes from, and what saving writes', () => {
    expect(budgetZoneWords(budget(), 'Asia/Singapore')).toBe(
      'Days reset at midnight, weeks on Monday, in America/New_York (written in machine.yaml).',
    );
    expect(budgetZoneWords(budget({ timeZoneSet: false }), 'Asia/Singapore')).toBe(
      'Days reset at midnight, weeks on Monday, in America/New_York — this machine’s own zone. Saving here writes yours (Asia/Singapore).',
    );
    expect(budgetZoneWords(undefined, 'Asia/Singapore')).toBe(
      'Days reset at midnight, weeks on Monday — counted in your zone (Asia/Singapore) once you save; it is written to machine.yaml.',
    );
  });
});

describe('budget drafts', () => {
  it('fills the editor from the budget the daemon last reported', () => {
    expect(budgetDraft(budget())).toEqual({
      dailyTrigger: '40',
      dailyHard: '60',
      weeklyTrigger: '200',
      weeklyHard: '300',
    });
    expect(budgetDraft(undefined)).toEqual({ dailyTrigger: '', dailyHard: '', weeklyTrigger: '', weeklyHard: '' });
    expect(budgetDraft(budget({ daily: period({ trigger: 40, hard: undefined }) })).dailyHard).toBe('');
  });

  it('parses a field as dollars above 0, taking a $ and blanks', () => {
    expect(parseBudgetAmount('')).toBeUndefined();
    expect(parseBudgetAmount('   ')).toBeUndefined();
    expect(parseBudgetAmount('40')).toBe(40);
    expect(parseBudgetAmount(' $12.50 ')).toBe(12.5);
    expect(Number.isNaN(parseBudgetAmount('0'))).toBe(true);
    expect(Number.isNaN(parseBudgetAmount('-3'))).toBe(true);
    expect(Number.isNaN(parseBudgetAmount('lots'))).toBe(true);
  });

  it('names why a draft cannot be saved', () => {
    expect(budgetDraftProblem(budgetDraft(budget()))).toBeNull();
    expect(budgetDraftProblem({ dailyTrigger: '40', dailyHard: '', weeklyTrigger: 'lots', weeklyHard: '' })).toBe(
      'Give every limit as dollars above 0, like 40 or 12.50.',
    );
    expect(budgetDraftProblem({ dailyTrigger: '40', dailyHard: '30', weeklyTrigger: '', weeklyHard: '' })).toBe(
      'The daily hard limit must not be below its trigger.',
    );
    expect(budgetDraftProblem({ dailyTrigger: '', dailyHard: '', weeklyTrigger: '100', weeklyHard: '90' })).toBe(
      'The weekly hard limit must not be below its trigger.',
    );
    expect(budgetDraftProblem({ dailyTrigger: '40', dailyHard: '40', weeklyTrigger: '', weeklyHard: '' })).toBeNull();
    expect(budgetDraftProblem(budgetDraft(undefined))).toBeNull();
  });

  it('writes a draft as the login’s budget key, dropping empty periods and removals', () => {
    expect(budgetOfDraft({ dailyTrigger: '40', dailyHard: '', weeklyTrigger: '', weeklyHard: '' })).toEqual({
      daily: { trigger: 40 },
    });
    expect(budgetOfDraft({ dailyTrigger: '40', dailyHard: '60', weeklyTrigger: '200', weeklyHard: '300' })).toEqual({
      daily: { trigger: 40, hard: 60 },
      weekly: { trigger: 200, hard: 300 },
    });
    expect(budgetOfDraft(budgetDraft(undefined))).toBeUndefined();
    expect(budgetOfDraft({ dailyTrigger: '', dailyHard: '', weeklyTrigger: '200', weeklyHard: '' })).toEqual({
      weekly: { trigger: 200 },
    });
  });

  it('knows whether a draft differs from the budget in effect, not from its text', () => {
    const view = budget();
    expect(budgetDraftChanged(budgetDraft(view), view)).toBe(false);
    expect(budgetDraftChanged({ ...budgetDraft(view), dailyTrigger: '40.00' }, view)).toBe(false);
    expect(budgetDraftChanged({ ...budgetDraft(view), dailyTrigger: '30' }, view)).toBe(true);
    expect(budgetDraftChanged(budgetDraft(undefined), undefined)).toBe(false);
    expect(budgetDraftChanged(budgetDraft(undefined), view)).toBe(true);
    expect(budgetDraftChanged(budgetDraft(view), undefined)).toBe(true);
  });
});
