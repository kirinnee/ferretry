/** Revoke all of one account's standing rules: counted and confirmed first, no passkey, and it says what the machine did. */

import { describe, expect, it } from 'bun:test';
import type { AccountSummary } from '@ferretry/protocol';
import { AccountRulesRevoke } from '../../../src/features/accounts/account-rules.tsx';
import { mount, must } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import { pageRule, ruleList, terminalRule } from '../../support/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const github = { id: 'GITHUB_WORK', label: 'github work' } as unknown as AccountSummary;

const screen = async (world: Parameters<typeof ruleClient>[0], passkeys: string[] = []) => {
  const fake = ruleClient(world);
  const mounted = await mount(
    <AccountRulesRevoke
      account={github}
      rules={{
        client: fake.client,
        askPasskey: async stage => {
          passkeys.push(stage);
          return true;
        },
      }}
    />,
  );
  await settle();
  return { fake, mounted };
};

describe('revoking all of an account’s rules', () => {
  it('draws nothing for an account with no rule, and counts only its own', async () => {
    const none = await screen({ list: ruleList({ rules: [terminalRule()] }) });
    const some = await screen({ list: ruleList({ rules: [pageRule(), terminalRule()] }) });
    try {
      expect(none.mounted.container.querySelector('[data-account-rules]')).toBeNull();
      expect(q(some.mounted.container, '[data-account-rules-count]').textContent).toContain(
        'github work has 1 standing rule listed here.',
      );
    } finally {
      await none.mounted.unmount();
      await some.mounted.unmount();
    }
  });

  it('asks for a confirmation first, sends nothing until then, and cancels without a call', async () => {
    const { fake, mounted } = await screen({ list: ruleList({ rules: [pageRule()] }) });
    try {
      await click(q(mounted.container, '[data-account-rules-revoke]'));
      expect(fake.keys().some(key => key.startsWith('POST /v1/accounts/'))).toBe(false);
      expect(q(mounted.container, '[data-account-rules-confirm]').textContent).toBe('Revoke 1 standing rule');
      await click(
        must(
          [...mounted.container.querySelectorAll('button')].find(b => b.textContent === 'Keep them'),
          'Keep',
        ),
      );
      expect(mounted.container.querySelector('[data-account-rules-confirm]')).toBeNull();
      expect(fake.keys().some(key => key.startsWith('POST /v1/accounts/'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('revokes with the account’s route and no passkey, then says how many went', async () => {
    const passkeys: string[] = [];
    const { fake, mounted } = await screen({ list: ruleList({ rules: [pageRule()] }), revoked: 1 }, passkeys);
    try {
      await click(q(mounted.container, '[data-account-rules-revoke]'));
      await click(q(mounted.container, '[data-account-rules-confirm]'));
      await settle();
      expect(fake.keys()).toContain('POST /v1/accounts/GITHUB_WORK/sign-in-rules/revoke');
      expect(passkeys).toEqual([]);
      const outcome = q(mounted.container, '[data-account-rules-outcome]');
      expect(outcome.getAttribute('data-account-rules-outcome')).toBe('revoked');
      expect(outcome.textContent).toBe('Revoked 1 standing rule. Ferrets ask you each time again.');
    } finally {
      await mounted.unmount();
    }
  });

  it('says why when the machine refuses', async () => {
    const { mounted } = await screen({
      list: ruleList({ rules: [pageRule()] }),
      fail: key => (key.endsWith('/revoke') ? refused('Something went wrong.', { status: 500 }) : undefined),
    });
    try {
      await click(q(mounted.container, '[data-account-rules-revoke]'));
      await click(q(mounted.container, '[data-account-rules-confirm]'));
      await settle();
      const outcome = q(mounted.container, '[data-account-rules-outcome]');
      expect(outcome.getAttribute('data-account-rules-outcome')).toBe('failed');
      expect(outcome.getAttribute('role')).toBe('alert');
    } finally {
      await mounted.unmount();
    }
  });
});
