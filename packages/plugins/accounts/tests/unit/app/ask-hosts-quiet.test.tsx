/**
 * The ask-card hosts read the daemon on their own while a chat is open. That is not the owner acting, so those reads
 * are QUIET (the client raises no passkey prompt), and a daemon that wants the step-up is answered by a short
 * "Confirm it's you to see this" button. Pressing it reads again, not quiet, which is when the passkey is asked for.
 */

import { describe, expect, it } from 'bun:test';
import { PhoneApprovalSchema } from '../../../contract/routes/index.ts';
import { SignInRuleSuggestionHost } from '../../../app/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { TaskPlanHost } from '../../../app/features/secure-copy/task-plan-host.tsx';
import { PhoneApprovalHost } from '../../../app/features/sign-in-approval/phone-approval-host.tsx';
import { TwoFactorSeedHost } from '../../../app/features/two-factor/two-factor-seed-host.tsx';
import { CONFIRM_TO_SEE_WORDS } from '../../../app/lib/step-up-refusal.ts';
import { mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { list as accountList, SI_GITHUB } from '../../support/app/accounts-fixtures.ts';
import { suggestion } from '../../support/app/sign-in-rule-fixtures.ts';
import { mixedPlan, PLAN_ID, SESSION } from '../../support/app/task-plan-fixtures.ts';

interface Seen {
  readonly route: string;
  readonly quiet: boolean;
}

/**
 * A daemon that wants the step-up for every route in `answers`: a QUIET read of one is refused the way the client hands
 * a refusal back (`403 grant_step_up_required`), and a read that is not quiet (the owner pressed) is answered, as the
 * client does once the passkey was given.
 */
const stepUpDaemon = (answers: Readonly<Record<string, unknown>>) => {
  const seen: Seen[] = [];
  const client = {
    call: async (route: string, init?: { readonly quiet?: boolean }) => {
      const quiet = init?.quiet === true;
      seen.push({ route, quiet });
      const answer = Object.entries(answers).find(([key]) => route === key)?.[1];
      if (answer === undefined) return {};
      if (quiet) throw Object.assign(new Error('step-up required'), { status: 403, code: 'grant_step_up_required' });
      return answer;
    },
  };
  return { client: client as never, seen };
};

const CONFIRM = '[data-confirm-to-see] button';
const confirm = (container: ParentNode): HTMLElement => must(container.querySelector<HTMLElement>(CONFIRM), CONFIRM);

const APPROVAL_ID = `pa_${'0'.repeat(23)}1`;
const phoneApproval = PhoneApprovalSchema.parse({
  id: APPROVAL_ID,
  sessionId: SESSION,
  agentName: 'lizzette',
  surface: 'browser',
  origin: 'https://company.okta.com',
  signIn: 'si_0123456789abcdef',
  account: { id: 'CLICKUP', label: 'ClickUp' },
  username: 'a@gmail.com',
  via: { id: 'OKTA', label: 'Okta' },
  raisedAt: '2026-10-31T14:02:00.000Z',
  expiresAt: '2099-10-31T14:04:00.000Z',
  state: 'refused',
});

const STAGE = 'st_0123456789abcdef01234567';
const ACCOUNT = accountList().accounts[0]?.id ?? 'GITHUB';

describe('the quiet ask-card hosts', () => {
  it('task plan: the on-load read is quiet, and the owner’s press reads again for real', async () => {
    const { client, seen } = stepUpDaemon({ 'GET /v1/accounts/plans': { plans: [mixedPlan()] } });
    const mounted = await mount(<TaskPlanHost client={client} ferret={SESSION} planId={PLAN_ID} />);
    try {
      await settle();
      expect(seen).toEqual([{ route: 'GET /v1/accounts/plans', quiet: true }]);
      expect(mounted.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
      expect(mounted.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).toBeNull();
      await click(confirm(mounted.container));
      await settle();
      expect(seen.at(-1)).toEqual({ route: 'GET /v1/accounts/plans', quiet: false });
      expect(mounted.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('phone approval: the on-load read is quiet, and the owner’s press reads again for real', async () => {
    const { client, seen } = stepUpDaemon({ 'GET /v1/phone-approvals': { approvals: [phoneApproval] } });
    const mounted = await mount(<PhoneApprovalHost approvalId={APPROVAL_ID} client={client} ferret={SESSION} />);
    try {
      await settle();
      expect(seen).toEqual([{ route: 'GET /v1/phone-approvals', quiet: true }]);
      expect(mounted.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
      await click(confirm(mounted.container));
      await settle();
      expect(seen.at(-1)).toEqual({ route: 'GET /v1/phone-approvals', quiet: false });
      expect(mounted.container.querySelector(CONFIRM)).toBeNull();
      expect(mounted.container.textContent).toContain('You stopped this sign-in.');
    } finally {
      await mounted.unmount();
    }
  });

  it('rule suggestion: every on-load read is quiet, and the owner’s press reads again for real', async () => {
    const { client, seen } = stepUpDaemon({
      'GET /v1/sign-in-rules/suggestions': { suggestions: [suggestion({ signIn: SI_GITHUB })] },
      'GET /v1/accounts': accountList(),
    });
    const mounted = await mount(
      <SignInRuleSuggestionHost client={client} ferret={SESSION} suggestionId={suggestion().id} />,
    );
    try {
      await settle();
      expect(seen.every(each => each.quiet)).toBe(true);
      expect(seen.map(each => each.route)).toContain('GET /v1/sign-in-rules/suggestions');
      expect(mounted.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
      const before = seen.length;
      await click(confirm(mounted.container));
      await settle();
      expect(seen.slice(before).find(each => each.route === 'GET /v1/sign-in-rules/suggestions')).toEqual({
        route: 'GET /v1/sign-in-rules/suggestions',
        quiet: false,
      });
      expect(mounted.container.querySelector(CONFIRM)).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('2FA seed: the on-load reads are quiet, and the owner’s press reads again for real', async () => {
    const { client, seen } = stepUpDaemon({
      [`GET /v1/accounts/${ACCOUNT}/factors/seed/${STAGE}`]: {
        stage: STAGE,
        account: ACCOUNT,
        label: 'Authenticator',
        state: 'waiting',
        expiresAt: '2099-10-31T14:04:00.000Z',
      },
      'GET /v1/accounts': accountList(),
    });
    const mounted = await mount(
      <TwoFactorSeedHost client={client} item={{ twoFactorSeed: { stage: STAGE as never, account: ACCOUNT } }} />,
    );
    try {
      await settle();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(each => each.quiet)).toBe(true);
      expect(mounted.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
      expect(mounted.container.querySelector('[data-seed-card]')).toBeNull();
      await click(confirm(mounted.container));
      await settle();
      expect(seen.some(each => !each.quiet)).toBe(true);
      expect(mounted.container.querySelector(CONFIRM)).toBeNull();
      expect(mounted.container.querySelector('[data-seed-card]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
