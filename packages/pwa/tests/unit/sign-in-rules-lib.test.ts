/** The words, flags and approval flow behind standing sign-in rules: warnings from structured fields, never from text. */

import { describe, expect, it } from 'bun:test';
import {
  draftOf,
  initialRuleTicks,
  passkeyWords,
  RULE_ROOT_WARNING,
  RULE_TERMINAL_LIMIT,
  RULE_TOTP_WARNING,
  ruleFlags,
  runRuleApproval,
  stagedFlags,
  ticksProblem,
  viewFlags,
} from '../../src/lib/sign-in-rules.ts';
import {
  codeRule,
  machineStage,
  pageRule,
  RULE_ID,
  SITE_SIGN_IN,
  STAGE_ID,
  stagedRule,
  terminalRule,
} from '../support/sign-in-rule-fixtures.ts';

const ticked = { username: true, password: true, totp: true, totpAcknowledged: true } as const;

describe('flags come from the structured fields', () => {
  it('shows the one-factor warning for a staged rule whose clipped summary never says so', () => {
    const staged = stagedRule({ totp: true, fields: ['password', 'totp'] });
    expect(staged.summary.join(' ')).not.toContain('code');
    expect(stagedFlags(staged).map(flag => flag.name)).toEqual(['one-factor']);
    expect(passkeyWords(staged)).toContain(RULE_TOTP_WARNING);
  });

  it('shows the root flag, the terminal limit and the residual sentence for a root stage', () => {
    const words = passkeyWords(machineStage());
    expect(words).toContain(RULE_ROOT_WARNING);
    expect(words).toContain(RULE_TERMINAL_LIMIT);
  });

  it('draws no flag from summary words when the booleans are false', () => {
    const staged = stagedRule({ summary: ['root one-factor auto recipe'] });
    expect(stagedFlags(staged)).toEqual([]);
    expect(passkeyWords(staged)).toBe('root one-factor auto recipe');
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
