/** The rule card and the create sheet: narrowing only takes away, and the root warnings come from the structured flag. */

import { describe, expect, it } from 'bun:test';
import { SignInRuleCard, type SignInRuleCardProps } from '../../../src/features/accounts/sign-in-rule-card.tsx';
import { SignInRuleSheet } from '../../../src/features/accounts/sign-in-rule-sheet.tsx';
import { RULE_TERMINAL_RESIDUAL } from '../../../src/lib/sign-in-rules.ts';
import { mount, must } from '../../support/dom.ts';
import { click, typeInto } from '../../support/dom-form.ts';
import {
  codeRule,
  pageRule,
  SITE_SIGN_IN,
  sitePlace,
  sudoPlace,
  terminalRule,
} from '../../support/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

const card = (rule: SignInRuleCardProps['rule'], extra: Partial<SignInRuleCardProps> = {}) => (
  <SignInRuleCard
    busy={false}
    canUsePasskey
    onNarrow={() => undefined}
    onReapprove={() => undefined}
    onRevoke={() => undefined}
    rule={rule}
    {...extra}
  />
);

describe('narrowing a rule', () => {
  it('refuses an end that is not earlier than the rule’s own, in whole days', async () => {
    const mounted = await mount(card(codeRule()));
    try {
      await click(q(mounted.container, '[data-rule-narrow]'));
      await typeInto(q(mounted.container, '[data-rule-end-days]'), '999');
      expect(q(mounted.container, '[role="status"]').textContent).toBe('End earlier than it does now, in whole days.');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-narrow-apply]').disabled).toBe(true);
      await typeInto(q(mounted.container, '[data-rule-end-days]'), '0');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-narrow-apply]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('refuses a cap that is not below what is left', async () => {
    const mounted = await mount(card(codeRule()));
    try {
      await click(q(mounted.container, '[data-rule-narrow]'));
      await typeInto(q(mounted.container, '[data-rule-cap]'), '4');
      expect(q(mounted.container, '[role="status"]').textContent).toBe('Lower the cap below what is left.');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-narrow-apply]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('sends the earlier end as an instant in whole days from now, then closes the form', async () => {
    const narrowed: unknown[] = [];
    const mounted = await mount(card(codeRule(), { onNarrow: narrow => narrowed.push(narrow) }));
    try {
      await click(q(mounted.container, '[data-rule-narrow]'));
      await typeInto(q(mounted.container, '[data-rule-end-days]'), '2');
      await typeInto(q(mounted.container, '[data-rule-cap]'), '3');
      expect(mounted.container.querySelector('[role="status"]')).toBeNull();
      await click(q(mounted.container, '[data-rule-narrow-apply]'));
      expect(narrowed).toEqual([{ expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), uses: 3 }]);
      expect(mounted.container.querySelector('[data-rule-narrow-form]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('has nothing to apply until something is narrowed, and Cancel puts the form away', async () => {
    const mounted = await mount(card(pageRule()));
    try {
      await click(q(mounted.container, '[data-rule-narrow]'));
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-narrow-apply]').disabled).toBe(true);
      expect(mounted.container.querySelector('[data-rule-drop-totp]')).toBeNull();
      await click(
        [...mounted.container.querySelectorAll('button')].find(button => button.textContent === 'Cancel') ?? null,
      );
      expect(mounted.container.querySelector('[data-rule-narrow-form]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a failure under the card as an alert', async () => {
    const mounted = await mount(card(pageRule(), { failure: 'could not narrow' }));
    try {
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('could not narrow');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the residual risk of a root rule', () => {
  it('is on a terminal rule’s card, from the root flag', async () => {
    const mounted = await mount(card(terminalRule()));
    try {
      expect(q(mounted.container, '[data-rule-terminal-residual]').textContent).toBe(RULE_TERMINAL_RESIDUAL);
    } finally {
      await mounted.unmount();
    }
  });

  it('is not on a page rule’s card', async () => {
    const mounted = await mount(card(pageRule()));
    try {
      expect(mounted.container.querySelector('[data-rule-terminal-residual]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  const sheet = (place: typeof sitePlace | typeof sudoPlace) => (
    <SignInRuleSheet
      accountName="github work"
      autoRecipe={false}
      canUsePasskey
      codeAvailable
      eligibility={{ signIn: SITE_SIGN_IN, eligible: true }}
      onApprove={() => undefined}
      onCancel={() => undefined}
      origin="owner"
      phase={{ kind: 'idle' }}
      place={place}
      scopes={[{ kind: 'any' }]}
    />
  );

  it('is on a terminal sheet, apart from the program limit', async () => {
    const mounted = await mount(sheet(sudoPlace));
    try {
      expect(q(mounted.container, '[data-rule-terminal-residual]').textContent).toBe(RULE_TERMINAL_RESIDUAL);
      expect(q(mounted.container, '[data-rule-terminal-limit]').textContent).not.toContain(RULE_TERMINAL_RESIDUAL);
    } finally {
      await mounted.unmount();
    }
  });

  it('is not on a page sheet', async () => {
    const mounted = await mount(sheet(sitePlace));
    try {
      expect(mounted.container.querySelector('[data-rule-terminal-residual]')).toBeNull();
      expect(mounted.container.querySelector('[data-rule-root]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
