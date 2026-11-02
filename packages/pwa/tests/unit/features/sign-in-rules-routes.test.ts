/** The rule routes and the sentences each refusal gets: what the browser sends, and what it says back. */

import { describe, expect, it } from 'bun:test';
import {
  SIGN_IN_RULE_ERROR_CODES,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
} from '@ferretry/protocol';
import {
  canRenew,
  canResume,
  dismissSuggestion,
  draftOf,
  dropRuleStage,
  INELIGIBLE_WORDS,
  isForbidden,
  listRules,
  listSuggestions,
  narrowRule,
  RULE_NO_PASSKEY_DEVICE_WORDS,
  readEligibility,
  revokeRule,
  runMachineRuleConfirm,
  runRuleApproval,
  scopeWords,
  statusWords,
  suspendableRules,
  suspendWarning,
  ticksProblem,
} from '../../../src/lib/sign-in-rules.ts';
import { refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import {
  machineStage,
  pageRule,
  RULE_ID,
  SITE_SIGN_IN,
  STAGE_ID,
  suspendedRule,
  terminalRule,
} from '../../support/sign-in-rule-fixtures.ts';

const ticks = {
  username: false,
  password: true,
  totp: false,
  totpAcknowledged: false,
  days: 30,
  uses: undefined,
  scope: { kind: 'any' },
} as const;
const draft = draftOf(SITE_SIGN_IN, ticks);

describe('the routes', () => {
  it('lists rules, reads eligibility and lists suggestions', async () => {
    const fake = ruleClient();
    expect((await listRules(fake.client)).rules).toEqual([]);
    expect(await readEligibility(fake.client, SITE_SIGN_IN)).toEqual({ signIn: SITE_SIGN_IN, eligible: true });
    expect((await listSuggestions(fake.client)).suggestions).toHaveLength(1);
    expect(fake.keys()).toEqual([
      'GET /v1/sign-in-rules',
      `GET /v1/sign-in-rules/eligibility?signIn=${SITE_SIGN_IN}`,
      'GET /v1/sign-in-rules/suggestions',
    ]);
  });

  it('narrows a rule by sending only what the owner took away', async () => {
    const fake = ruleClient();
    await narrowRule(fake.client, RULE_ID, { dropTotp: true, uses: 2 });
    expect(fake.calls).toEqual([
      { key: `POST /v1/sign-in-rules/${RULE_ID}/narrow`, body: { dropTotp: true, uses: 2 } },
    ]);
  });

  it('revokes a rule, drops a stage and dismisses a suggestion with a DELETE each', async () => {
    const fake = ruleClient();
    await revokeRule(fake.client, RULE_ID);
    await dropRuleStage(fake.client, STAGE_ID);
    await dismissSuggestion(fake.client, 'srg_dddddddddddddddd');
    expect(fake.keys()).toEqual([
      `DELETE /v1/sign-in-rules/${RULE_ID}`,
      `DELETE /v1/sign-in-rules/stages/${STAGE_ID}`,
      'DELETE /v1/sign-in-rules/suggestions/srg_dddddddddddddddd',
    ]);
  });

  it('reads only a 403 as the daemon refusing this device', () => {
    expect(isForbidden(refused('no', { status: 403 }))).toBe(true);
    expect(isForbidden(refused('no', { status: 500 }))).toBe(false);
    expect(isForbidden('nope')).toBe(false);
  });
});

describe('what a refused approval says', () => {
  const cases: readonly (readonly [keyof typeof SIGN_IN_RULE_ERROR_CODES, string])[] = [
    ['passkeyRequired', INELIGIBLE_WORDS['no-passkey']],
    ['stageNotFound', 'That approval timed out or was already answered. Start it again.'],
    ['noHistory', INELIGIBLE_WORDS['no-history']],
    ['viaProvider', INELIGIBLE_WORDS['via-provider']],
    ['notPassword', INELIGIBLE_WORDS['not-password']],
    ['toolNotCovered', INELIGIBLE_WORDS['tool-not-covered']],
    ['noCodeKey', 'This account has no 2FA key Ferretry makes codes for, so the code can’t be ticked.'],
    ['conflict', 'The sign-in changed while you were approving it, so nothing was approved. Start again.'],
    ['proofInvalid', 'The passkey did not match this rule, so nothing was approved.'],
  ];

  for (const [name, words] of cases)
    it(`says the daemon's sentence for ${name}`, async () => {
      const fake = ruleClient({
        fail: key =>
          key === 'POST /v1/sign-in-rules/stages' ? refused('x', { code: SIGN_IN_RULE_ERROR_CODES[name] }) : undefined,
      });
      const outcome = await runRuleApproval({ client: fake.client, askPasskey: async () => true }, draft);
      expect(outcome).toEqual({ kind: 'failed', words });
    });

  it('says the daemon’s own message for a refusal it has no sentence for', async () => {
    const fake = ruleClient({ fail: key => (key.endsWith('/commit') ? refused('disk full') : undefined) });
    const outcome = await runRuleApproval({ client: fake.client, askPasskey: async () => true }, draft);
    expect(outcome).toEqual({ kind: 'failed', words: 'disk full' });
  });

  it('drops the stage when the passkey prompt throws', async () => {
    const fake = ruleClient();
    const outcome = await runRuleApproval(
      {
        client: fake.client,
        askPasskey: async () => {
          throw new Error('the prompt broke');
        },
      },
      draft,
    );
    expect(outcome).toEqual({ kind: 'failed', words: 'the prompt broke' });
    expect(fake.keys()).toEqual(['POST /v1/sign-in-rules/stages', `DELETE /v1/sign-in-rules/stages/${STAGE_ID}`]);
  });

  it('reports each step in order', async () => {
    const steps: string[] = [];
    const fake = ruleClient();
    const outcome = await runRuleApproval(
      { client: fake.client, askPasskey: async () => true, report: step => steps.push(step) },
      draft,
    );
    expect(outcome.kind).toBe('settled');
    expect(steps).toEqual(['staging', 'passkey', 'committing']);
  });

  it('still reports a dismissed passkey when the drop itself fails', async () => {
    const fake = ruleClient({ fail: key => (key.startsWith('DELETE') ? refused('gone') : undefined) });
    const outcome = await runRuleApproval({ client: fake.client, askPasskey: async () => false }, draft);
    expect(outcome).toEqual({ kind: 'dismissed' });
  });
});

describe('a rule staged at the machine', () => {
  it('binds the stage, asks the passkey for it and commits', async () => {
    const asked: string[] = [];
    const rows: string[] = [];
    const warnings: string[] = [];
    const fake = ruleClient({ staged: machineStage() });
    const outcome = await runMachineRuleConfirm(
      {
        client: fake.client,
        askPasskey: async (stage, words) => {
          asked.push(stage, words.does);
          rows.push(...words.rows.map(row => row.label));
          warnings.push(...words.warnings);
          return true;
        },
      },
      STAGE_ID,
    );
    expect(outcome.kind).toBe('settled');
    expect(fake.keys()).toEqual([
      `POST /v1/sign-in-rules/stages/${STAGE_ID}/bind`,
      `POST /v1/sign-in-rules/stages/${STAGE_ID}/commit`,
    ]);
    expect(asked[0]).toBe(STAGE_ID);
    expect(asked[1]).toBe("Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.");
    expect(rows).toEqual(['Machine', 'Types', 'Who', 'Until', 'Uses']);
    expect(warnings).toEqual([SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL]);
  });

  it('drops a dismissed stage and commits nothing', async () => {
    const fake = ruleClient({ staged: machineStage() });
    const outcome = await runMachineRuleConfirm({ client: fake.client, askPasskey: async () => false }, STAGE_ID);
    expect(outcome.kind).toBe('dismissed');
    expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(false);
    expect(fake.keys().some(key => key.startsWith('DELETE'))).toBe(true);
  });

  it('has no passkey to ask on this device, so it drops the stage and says so', async () => {
    const fake = ruleClient({ staged: machineStage() });
    const outcome = await runMachineRuleConfirm({ client: fake.client, askPasskey: undefined }, STAGE_ID);
    expect(outcome).toEqual({ kind: 'failed', words: RULE_NO_PASSKEY_DEVICE_WORDS });
    expect(fake.keys().at(-1)).toBe(`DELETE /v1/sign-in-rules/stages/${STAGE_ID}`);
  });

  it('says the daemon’s sentence when the stage is gone', async () => {
    const fake = ruleClient({
      fail: key => (key.endsWith('/bind') ? refused('x', { code: SIGN_IN_RULE_ERROR_CODES.stageNotFound }) : undefined),
    });
    const outcome = await runMachineRuleConfirm({ client: fake.client, askPasskey: async () => true }, STAGE_ID);
    expect(outcome).toEqual({
      kind: 'failed',
      words: 'That approval timed out or was already answered. Start it again.',
    });
  });
});

describe('the owner’s words', () => {
  it('says where a rule applies', () => {
    expect(scopeWords({ kind: 'any' })).toBe('Any ferret on this machine');
    expect(scopeWords({ kind: 'project', project: '7f1c1a1e-6d0c-4f6e-9a8e-0d3f1f7d2a11' })).toBe(
      'Ferrets in board project 7f1c1a1e-6d0c-4f6e-9a8e-0d3f1f7d2a11',
    );
    expect(scopeWords({ kind: 'session', session: 'ses_abcdefghijklmnop' })).toBe('Session ses_abcdefghijklmnop');
  });

  it('says the status, with the reason for a suspension and the wait for an unverified rule', () => {
    expect(statusWords(pageRule())).toBe('Active');
    expect(statusWords(pageRule({ unverified: true }))).toBe('Active once Ferretry has checked it');
    expect(statusWords(suspendedRule()).startsWith('Suspended: ')).toBe(true);
    expect(statusWords(pageRule({ status: 'used-up' }))).toBe('All uses spent');
    expect(statusWords(pageRule({ status: 'expired' }))).toBe('Expired');
  });

  it('lets a suspended rule resume unless its sign-in is gone, and an ended rule renew', () => {
    expect(canResume(suspendedRule())).toBe(true);
    expect(
      canResume(
        pageRule({ status: 'suspended', suspended: { at: '2026-10-31T09:00:00.000Z', because: 'sign-in-gone' } }),
      ),
    ).toBe(false);
    expect(canResume(pageRule())).toBe(false);
    expect(canRenew(pageRule({ status: 'expired' }))).toBe(true);
    expect(canRenew(pageRule({ status: 'used-up' }))).toBe(true);
    expect(canRenew(pageRule())).toBe(false);
  });

  it('counts only the live rules of this sign-in as ones an edit would suspend', () => {
    const rules = [pageRule(), pageRule({ status: 'expired' }), terminalRule()];
    expect(suspendableRules(rules, SITE_SIGN_IN)).toHaveLength(1);
    expect(suspendWarning(1)).toBe('Saving this suspends 1 standing rule: you approve again with a passkey.');
    expect(suspendWarning(2)).toBe('Saving this suspends 2 standing rules: you approve again with a passkey.');
  });

  it('refuses a "most uses" that is not a whole number of 1 or more', () => {
    expect(ticksProblem({ ...ticks, uses: 0 }, 'page')).toBe('The most uses is a whole number, 1 to 1000.');
    expect(ticksProblem({ ...ticks, uses: 2.5 }, 'page')).toBe('The most uses is a whole number, 1 to 1000.');
    expect(ticksProblem({ ...ticks, uses: 3 }, 'page')).toBeUndefined();
  });
});
