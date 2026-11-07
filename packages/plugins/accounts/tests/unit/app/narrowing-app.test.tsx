/**
 * G128a–G128f, S110 and S104/S125 on the app half: what only TAKES AWAY (revoke, narrow, delete, drop) goes out as its
 * one route and never asks for a passkey, and a warning is drawn from the daemon's structured flag, never from words.
 * The daemon side is `narrowing.test.ts`; these drive the real screens against a client that records every route.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { PasteRule } from '../../../contract/routes/index.ts';
import {
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
} from '../../../contract/routes/index.ts';
import { AccountRulesRevoke } from '../../../app/features/accounts/account-rules.tsx';
import { CopyRulesSurface } from '../../../app/features/secure-copy/copy-rules-surface.tsx';
import { SignInRulesSurface } from '../../../app/features/secure-copy/sign-in-rules-surface.tsx';
import { TaskPlanHost } from '../../../app/features/secure-copy/task-plan-host.tsx';
import { type Mounted, mount, must } from '../../support/app/dom.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { answeredClient, fakeClient } from '../../support/app/fake-client.ts';
import { ruleClient } from '../../support/app/sign-in-rule-client.ts';
import {
  codeRule,
  machineStage,
  pageRule,
  RULE_ID,
  ruleList,
  STAGE_ID,
  terminalRule,
} from '../../support/app/sign-in-rule-fixtures.ts';
import { approvedPlan, PLAN_ID, SESSION } from '../../support/app/task-plan-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

/** A passkey prompt that notes it was asked: a narrowing must leave it empty. */
const passkeys = () => {
  const asked: string[] = [];
  return {
    asked,
    ask: async (stage: string) => {
      asked.push(stage);
      return true;
    },
  };
};

const view = async (element: React.ReactElement) => {
  const each = await mount(element);
  mounted.push(each);
  await settle();
  return { q: (selector: string) => each.container.querySelector<HTMLElement>(selector), container: each.container };
};

describe('what only takes away asks no passkey', () => {
  it('G128a revoking a task-plan line is one POST to the plan’s revoke route and never asks a passkey', async () => {
    const { ask, asked } = passkeys();
    const fake = answeredClient({
      'GET /v1/accounts/plans': { plans: [approvedPlan()] },
      [`POST /v1/ferrets/${SESSION}/task-plans/${PLAN_ID}/revoke`]: { ...approvedPlan(), state: 'revoked' },
    });
    const screen = await view(<TaskPlanHost askPasskey={ask} client={fake.client} ferret={SESSION} planId={PLAN_ID} />);

    await click(must(screen.q('[data-task-plan-revoke]') ?? screen.q('[data-task-plan-revoke-all]'), 'a revoke'));
    await settle();

    expect(fake.calls.filter(call => call.method === 'POST').map(call => call.route)).toEqual([
      'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke',
    ]);
    expect(asked).toEqual([]);
  });

  it('G128b and S110 narrowing a sign-in rule is one POST to its narrow route, with only what was taken away, and no passkey', async () => {
    const { ask, asked } = passkeys();
    const fake = ruleClient({ list: ruleList({ rules: [codeRule()] }) });
    const screen = await view(<SignInRulesSurface askPasskey={ask} client={fake.client} pollMs={60_000} />);

    await click(screen.q('[data-rule-narrow]'));
    await click(screen.q('[data-rule-drop-totp]'));
    await click(screen.q('[data-rule-narrow-apply]'));
    await settle();

    const sent = fake.calls.filter(call => call.key.startsWith('POST'));
    expect(sent.map(call => call.key)).toEqual([`POST /v1/sign-in-rules/${codeRule().id}/narrow`]);
    expect(sent[0]?.body).toEqual({ dropTotp: true });
    expect(asked).toEqual([]);
  });

  it('G128c and S110 revoking a sign-in rule is one DELETE of that rule and never asks a passkey', async () => {
    const { ask, asked } = passkeys();
    const fake = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
    const screen = await view(<SignInRulesSurface askPasskey={ask} client={fake.client} pollMs={60_000} />);

    await click(screen.q('[data-rule-revoke]'));
    await settle();

    expect(fake.keys().filter(key => key.startsWith('DELETE'))).toEqual([`DELETE /v1/sign-in-rules/${RULE_ID}`]);
    expect(asked).toEqual([]);
  });

  it('G128d revoking every rule of an account is one POST for that account, counted and confirmed first, and never asks a passkey', async () => {
    const { ask, asked } = passkeys();
    const fake = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
    const screen = await view(
      <AccountRulesRevoke
        account={{ id: 'GITHUB_WORK', label: 'github work' } as never}
        rules={{ client: fake.client, askPasskey: ask }}
      />,
    );

    await click(screen.q('[data-account-rules-revoke]'));
    expect(fake.keys().some(key => key.startsWith('POST /v1/accounts/'))).toBe(false);
    await click(screen.q('[data-account-rules-confirm]'));
    await settle();

    expect(fake.keys().filter(key => key.startsWith('POST'))).toEqual([
      'POST /v1/accounts/GITHUB_WORK/sign-in-rules/revoke',
    ]);
    expect(asked).toEqual([]);
  });

  it('G128e removing a paste rule is one DELETE of that rule and never asks a passkey', async () => {
    const { ask, asked } = passkeys();
    const rule: PasteRule = {
      id: 'a'.repeat(32),
      from: { kind: 'command', program: 'gh' },
      to: { kind: 'terminal', program: 'vercel' },
      used: 0,
      createdAt: '2026-08-05T09:00:00.000Z',
      createdBy: { kind: 'host' },
    };
    const fake = fakeClient(call =>
      call.method === 'DELETE'
        ? { removed: true }
        : call.path.endsWith('/settings')
          ? { settings: { allowProfileTargets: false }, profileRules: [] }
          : call.path.endsWith('/stages')
            ? { stages: [] }
            : { rules: [rule] },
    );
    const screen = await view(<CopyRulesSurface askPasskey={ask} client={fake.client} />);

    await click(screen.q(`[data-copy-rule="${rule.id}"] button`));
    await settle();

    expect(fake.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([
      `/v1/copy-rules/${rule.id}`,
    ]);
    expect(asked).toEqual([]);
  });

  it('G128f denying a paste rule a machine staged drops the stage and never asks a passkey', async () => {
    const { ask, asked } = passkeys();
    const STAGE = `prs_${'1'.repeat(24)}`;
    const staged = {
      stage: STAGE,
      kind: 'rule',
      does: 'Ferretry pastes what gh prints into vercel in a terminal, for any ferret on this machine, without asking.',
      rows: [{ label: 'From', value: 'what gh prints' }],
      runsAnything: false,
      expiresAt: '2026-11-02T09:02:00.000Z',
    };
    const fake = fakeClient(call =>
      call.method === 'DELETE'
        ? { stage: STAGE, dropped: true }
        : call.path === '/v1/copy-rules/stages'
          ? { stages: [staged] }
          : call.path.endsWith('/settings')
            ? { settings: { allowProfileTargets: false }, profileRules: [] }
            : { rules: [] },
    );
    const screen = await view(<CopyRulesSurface askPasskey={ask} client={fake.client} />);

    await click(screen.q('[data-copy-rule-waiting-deny]'));
    await settle();

    expect(fake.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([
      `/v1/copy-rules/stages/${STAGE}`,
    ]);
    expect(asked).toEqual([]);
  });

  it('G128f a paste rule is made only through its own stage and passkey, never by a one-step add', async () => {
    const fake = fakeClient(call =>
      call.method === 'POST'
        ? { stage: `prs_${'2'.repeat(24)}` }
        : call.path === '/v1/copy-rules/stages'
          ? { stages: [] }
          : call.path.endsWith('/settings')
            ? { settings: { allowProfileTargets: false }, profileRules: [] }
            : { rules: [] },
    );
    const screen = await view(<CopyRulesSurface client={fake.client} />);

    await click(screen.q('[data-copy-rule-add-open]'));
    await typeInto(screen.q('[data-copy-rule-from]'), 'gh');
    await typeInto(screen.q('[data-copy-rule-to]'), 'vercel');
    await settle();

    expect(fake.calls.some(call => call.route === 'POST /v1/copy-rules')).toBe(false);
  });
});

describe('a warning comes from the structured flag', () => {
  it('S104 a staged terminal rule draws the root warning from the flag even when its own words do not say it', async () => {
    const fake = ruleClient({
      list: ruleList({ stages: [{ ...machineStage(), does: 'Ferretry types a password.' }] }),
    });
    const screen = await view(<SignInRulesSurface client={fake.client} pollMs={60_000} />);

    expect(screen.q('[data-rule-flag="root"]')?.textContent).toContain(SIGN_IN_RULE_ROOT_WARNING);
    expect(screen.q('[data-rule-stage]')?.getAttribute('data-rule-stage')).toBe(STAGE_ID);
  });

  it('S125 a terminal rule shows the root warning, the residual-risk line and the honest limit, verbatim', async () => {
    const fake = ruleClient({ list: ruleList({ rules: [terminalRule()] }) });
    const screen = await view(<SignInRulesSurface client={fake.client} pollMs={60_000} />);
    const text = screen.container.textContent ?? '';

    expect(text).toContain(SIGN_IN_RULE_ROOT_WARNING);
    expect(text).toContain(SIGN_IN_RULE_TERMINAL_RESIDUAL);
    expect(text).toContain(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT);
  });
});
