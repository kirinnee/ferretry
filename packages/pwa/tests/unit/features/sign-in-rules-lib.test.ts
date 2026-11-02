/** The words, flags and approval flow behind standing sign-in rules: warnings from structured fields, never from text. */

import { describe, expect, it } from 'bun:test';
import {
  SIGN_IN_RULE_ERROR_CODES,
  SIGN_IN_RULE_INELIGIBLE_WORDS,
  SIGN_IN_RULE_MAX_USES,
  SIGN_IN_RULE_REFUSAL_WORDS,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TOTP_WARNING,
} from '@ferretry/protocol';
import {
  checkedWords,
  codeKeyLabel,
  draftOf,
  initialRuleTicks,
  narrowEnd,
  passkeyWords,
  RULE_HONEST_LIMIT,
  ruleFailureWords,
  ruleFlags,
  ruleWordsOf,
  runRuleApproval,
  sheetWords,
  stagedFlags,
  ticksProblem,
  viewFlags,
} from '../../../src/lib/sign-in-rules.ts';
import {
  codeRule,
  machineStage,
  pageRule,
  RULE_ID,
  SITE_SIGN_IN,
  STAGE_ID,
  stagedRule,
  sitePlace,
  sudoPlace,
  terminalRule,
} from '../../support/sign-in-rule-fixtures.ts';

const ticked = { username: true, password: true, totp: true, totpAcknowledged: true } as const;

describe('flags come from the structured fields', () => {
  it('shows the one-factor warning for a staged rule whose words never say so', () => {
    const staged = stagedRule({ totp: true, fields: ['password', 'totp'], does: 'Ferretry types the password.' });
    expect(staged.does).not.toContain('code');
    expect(stagedFlags(staged).map(flag => flag.name)).toEqual(['one-factor']);
    expect(passkeyWords(staged).warnings).toEqual([SIGN_IN_RULE_TOTP_WARNING]);
  });

  it('gives a root stage the root warning and the split-second sentence, and no more', () => {
    expect(passkeyWords(machineStage()).warnings).toEqual([SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL]);
  });

  it('keeps the red block to two short sentences', () => {
    const words = passkeyWords(machineStage()).warnings;
    expect(words.length).toBeLessThanOrEqual(2);
    expect(SIGN_IN_RULE_TERMINAL_RESIDUAL.split(/\s+/u).length).toBeLessThanOrEqual(25);
  });

  it("hands the dialog the daemon's own line and rows, as staged", () => {
    const staged = machineStage();
    const words = passkeyWords(staged);
    expect(words.does).toBe("Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.");
    expect(words.rows).toEqual(staged.rows);
    expect(words.rows.map(row => row.label)).toEqual(['Machine', 'Types', 'Who', 'Until', 'Uses']);
  });

  it('puts a row that looks like a warning, or holds a blank line, in the rows and never in the red block', () => {
    const rows = [
      { label: 'Machine', value: 'kirin-box' },
      { label: 'Types', value: 'the sudo password' },
      { label: 'Who', value: SIGN_IN_RULE_ROOT_WARNING },
      { label: 'Until', value: `2026-11-02\n\n${SIGN_IN_RULE_TERMINAL_RESIDUAL}` },
      { label: 'Uses', value: 'No limit' },
    ];
    const words = passkeyWords({ ...stagedRule(), rows } as never);
    expect(words.rows).toEqual(rows);
    expect(words.warnings).toEqual([]);
  });

  it('puts no residual sentence on a page rule', () => {
    expect(passkeyWords(stagedRule()).warnings).toEqual([]);
  });

  it('draws no flag from the words when the booleans are false', () => {
    const staged = stagedRule({ does: 'root one-factor auto recipe' });
    expect(stagedFlags(staged)).toEqual([]);
    expect(passkeyWords(staged)).toEqual({
      does: 'root one-factor auto recipe',
      rows: staged.rows,
      warnings: [],
      cautions: [],
    });
  });

  it('names the proof behind a collapsed line, root or not', () => {
    expect(checkedWords(true)).toEqual([SIGN_IN_RULE_TERMINAL_HONEST_LIMIT, RULE_HONEST_LIMIT]);
    expect(checkedWords(false)).toEqual([RULE_HONEST_LIMIT]);
  });

  it('reads a listed rule from its flags array', () => {
    expect(viewFlags(codeRule()).map(flag => flag.name)).toEqual(['one-factor']);
    expect(viewFlags(terminalRule()).map(flag => flag.name)).toEqual(['root']);
    expect(viewFlags(pageRule())).toEqual([]);
    expect(ruleFlags({ root: true, totp: true, autoRecipe: true }).map(flag => flag.name)).toEqual([
      'root',
      'one-factor',
      'auto-recipe',
    ]);
  });
});

describe('the sheet ticks', () => {
  it('ticks NOTHING for a ferret suggestion', () => {
    const ticks = initialRuleTicks({ surface: 'page', origin: 'suggestion', hasUsername: true });
    expect([ticks.username, ticks.password, ticks.totp]).toEqual([false, false, false]);
    expect(ticksProblem(ticks, 'page')).toBe('Tick what Ferretry may type.');
  });

  it('never carries the code over on resume or renew', () => {
    const ticks = initialRuleTicks({ surface: 'page', origin: 'renew', hasUsername: true, before: codeRule() });
    expect(ticks.totp).toBe(false);
    expect(ticks.password).toBe(true);
  });

  it('needs the acknowledgement for the code, and the password with it', () => {
    expect(ticksProblem({ ...ticked, totpAcknowledged: false } as never, 'page')).toContain('one factor');
    expect(ticksProblem({ ...ticked, password: false } as never, 'page')).toContain('password');
    expect(ticksProblem(ticked as never, 'page')).toBeUndefined();
  });

  it('refuses a username or a code on a terminal rule', () => {
    const base = { ...ticked, days: 1, uses: undefined, scope: { kind: 'any' } } as never;
    expect(ticksProblem(base, 'terminal')).toContain('password only');
  });

  it('builds a draft with the code and its acknowledgement together, and the lifetime in seconds', () => {
    const draft = draftOf(SITE_SIGN_IN, { ...ticked, days: 7, uses: 3, scope: { kind: 'any' } } as never);
    expect(draft.totp).toBe(true);
    expect(draft.totpAcknowledged).toBe(true);
    expect(draft.lifetimeSeconds).toBe(7 * 86_400);
    expect(draft.uses).toBe(3);
  });
});

describe('the approval', () => {
  const draft = draftOf(SITE_SIGN_IN, {
    ...ticked,
    totp: false,
    days: 30,
    uses: undefined,
    scope: { kind: 'any' },
  } as never);

  const clientFor = (calls: string[]) => ({
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path}`;
      calls.push(key);
      if (key === 'POST /v1/sign-in-rules/stages') return schema.parse(stagedRule());
      if (key === `DELETE /v1/sign-in-rules/stages/${STAGE_ID}`)
        return schema.parse({ stage: STAGE_ID, dropped: true });
      if (key === `POST /v1/sign-in-rules/stages/${STAGE_ID}/commit`) return schema.parse(pageRule({ id: RULE_ID }));
      throw new Error(`no answer for ${key}`);
    },
  });

  it('DROPS the stage when the passkey is dismissed and commits nothing', async () => {
    const calls: string[] = [];
    const outcome = await runRuleApproval({ client: clientFor(calls) as never, askPasskey: async () => false }, draft);
    expect(outcome.kind).toBe('dismissed');
    expect(calls.some(call => call.startsWith('DELETE'))).toBe(true);
    expect(calls.some(call => call.endsWith('/commit'))).toBe(false);
  });

  it('asks the passkey for the stage id alone and commits once it is given', async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    const outcome = await runRuleApproval(
      {
        client: clientFor(calls) as never,
        askPasskey: async stage => {
          asked.push(stage);
          return true;
        },
      },
      draft,
    );
    expect(outcome.kind).toBe('settled');
    expect(asked).toEqual([STAGE_ID]);
    expect(calls.some(call => call.startsWith('DELETE'))).toBe(false);
  });

  it('drops the stage and says why on a device with no passkey', async () => {
    const calls: string[] = [];
    const outcome = await runRuleApproval({ client: clientFor(calls) as never, askPasskey: undefined }, draft);
    expect(outcome.kind).toBe('failed');
    expect(calls.some(call => call.startsWith('DELETE'))).toBe(true);
  });
});

describe('the ticks cap', () => {
  const base = {
    username: false,
    password: true,
    totp: false,
    totpAcknowledged: false,
    days: 7,
    scope: { kind: 'any' },
  };

  it('accepts a whole number of uses up to the most a daemon stages', () => {
    expect(ticksProblem({ ...base, uses: 1 } as never, 'page')).toBeUndefined();
    expect(ticksProblem({ ...base, uses: SIGN_IN_RULE_MAX_USES } as never, 'page')).toBeUndefined();
  });

  it('refuses more uses than the most, a fraction or zero', () => {
    for (const uses of [SIGN_IN_RULE_MAX_USES + 1, 1.5, 0]) {
      expect(ticksProblem({ ...base, uses } as never, 'page')).toBe('The most uses is a whole number, 1 to 1000.');
    }
  });
});

describe('the words the sheet and the card draw', () => {
  const ticks = initialRuleTicks({ surface: 'page', origin: 'owner', hasUsername: true });

  it('names the site and the pinned code key on the sheet, once the code is ticked', () => {
    const plain = sheetWords({
      accountName: 'github work',
      username: 'kirin@atomi.cloud',
      place: sitePlace,
      ticks,
      codeKey: 'GitHub authenticator',
    });
    expect(plain.rows).toEqual([
      { label: 'Site', value: 'github.com' },
      { label: 'Account', value: 'github work · kirin@atomi.cloud' },
    ]);
    expect(plain.does).toBe('Ferretry signs in to github.com as github work for any ferret, without asking.');
    const withCode = sheetWords({
      accountName: 'github work',
      place: sitePlace,
      ticks: { ...ticks, totp: true },
      codeKey: 'GitHub authenticator',
    });
    expect(withCode.rows.map(row => row.label)).toEqual(['Site', 'Account', 'Code key']);
    expect(withCode.rows[2]?.value).toBe('GitHub authenticator');
  });

  it('names the machine on a terminal sheet, and whose password it is', () => {
    const words = sheetWords({
      accountName: 'kirin',
      username: 'kirin',
      place: sudoPlace,
      ticks: initialRuleTicks({ surface: 'terminal', origin: 'owner', hasUsername: false }),
    });
    expect(words.does).toBe("Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.");
    expect(words.rows).toEqual([{ label: 'Machine', value: 'kirin-box' }]);
  });

  it('pins the NEWEST automatic key, as the daemon does', () => {
    const key = (id: string, label: string, addedAt: string, automatic = true) => ({ id, label, addedAt, automatic });
    expect(codeKeyLabel([])).toBeUndefined();
    expect(codeKeyLabel([key('a', 'manual', '2026-10-31T00:00:00.000Z', false)])).toBeUndefined();
    expect(
      codeKeyLabel([key('a', 'old', '2026-10-01T00:00:00.000Z'), key('b', 'new', '2026-10-20T00:00:00.000Z')]),
    ).toBe('new');
    expect(
      codeKeyLabel([key('b', 'second', '2026-10-01T00:00:00.000Z'), key('a', 'first', '2026-10-01T00:00:00.000Z')]),
    ).toBe('first');
  });

  it('says what is left and who approved it on a listed rule', () => {
    const words = ruleWordsOf(codeRule());
    expect(words.rows.find(row => row.label === 'Uses')?.value).toBe(
      '4 of 5 uses left · used 1×, last 2026-10-31 09:00 UTC',
    );
    expect(ruleWordsOf(pageRule()).rows.find(row => row.label === 'Uses')?.value).toBe('No limit · not used yet');
    expect(words.rows.at(-1)).toEqual({ label: 'Approved with', value: 'Kirin’s phone' });
    expect(ruleWordsOf(terminalRule()).does).toBe(
      "Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.",
    );
  });
});

describe('each refusal its own sentence (C1)', () => {
  const as = (code: string) => Object.assign(new Error('daemon words'), { status: 409, code });

  it('says a rule that exists, a rule that changed and a clock that moved back apart from a changed sign-in', () => {
    const words = ['rule_exists', 'not_this_rule', 'clock_moved_back', 'conflict'].map(code =>
      ruleFailureWords(as(code)),
    );
    expect(words).toEqual([
      SIGN_IN_RULE_REFUSAL_WORDS.rule_exists,
      SIGN_IN_RULE_REFUSAL_WORDS.not_this_rule,
      SIGN_IN_RULE_REFUSAL_WORDS.clock_moved_back,
      SIGN_IN_RULE_REFUSAL_WORDS.conflict,
    ]);
    expect(new Set(words).size).toBe(4);
    expect(words[0]).not.toContain('changed');
  });

  it('says sudo on a machine without terminal rules in its own words', () => {
    expect(ruleFailureWords(as(SIGN_IN_RULE_ERROR_CODES.terminalOff))).toBe(
      SIGN_IN_RULE_INELIGIBLE_WORDS['terminal-off'],
    );
  });
});

describe('narrowing a rule to an end the owner typed', () => {
  const NOW = Date.parse('2026-05-01T00:00:00.000Z');
  const ENDS = '2026-05-03T00:00:00.000Z';

  it('takes whole hours and whole days that end before the rule now does', () => {
    expect(narrowEnd('3', 'hours', ENDS, NOW)).toEqual({ ok: true, at: '2026-05-01T03:00:00.000Z' });
    expect(narrowEnd('1', 'days', ENDS, NOW)).toEqual({ ok: true, at: '2026-05-02T00:00:00.000Z' });
  });

  it('refuses a fraction, zero, less than the one-hour minimum, and an end that is not earlier', () => {
    for (const [typed, unit] of [
      ['1.5', 'hours'],
      ['0', 'hours'],
      ['', 'hours'],
      ['48', 'hours'],
      ['2', 'days'],
      ['0', 'days'],
    ] as const)
      expect(narrowEnd(typed, unit, ENDS, NOW).ok).toBe(false);
  });
});
