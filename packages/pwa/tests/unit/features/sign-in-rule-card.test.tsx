/** The rule card and the create sheet: narrowing only takes away, and the root warnings come from the structured flag. */

import { describe, expect, it } from 'bun:test';
import {
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TOTP_WARNING,
} from '@ferretry/protocol';
import { SignInRuleCard, type SignInRuleCardProps } from '../../../src/features/accounts/sign-in-rule-card.tsx';
import { SignInRuleSheet, type SignInRuleSheetProps } from '../../../src/features/accounts/sign-in-rule-sheet.tsx';
import { RULE_HONEST_LIMIT as SIGN_IN_RULE_HONEST_LIMIT } from '../../../src/lib/sign-in-rules.ts';
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

const sheet = (place: typeof sitePlace | typeof sudoPlace, extra: Partial<SignInRuleSheetProps> = {}) => (
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
    {...extra}
  />
);

const flagLines = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-rule-warnings] p')].map(line => line.textContent ?? '');

describe('one shape on every rule screen', () => {
  it('is a plain line, label/value rows and ONE red block with no row inside it, on a terminal card', async () => {
    const mounted = await mount(card(terminalRule()));
    try {
      expect(q(mounted.container, '[data-rule-does]').textContent).toBe(
        "Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.",
      );
      const labels = [...mounted.container.querySelectorAll('dl[data-rule-rows] dt')].map(each => each.textContent);
      expect(labels).toEqual(['Machine', 'Types', 'Who', 'Until', 'Uses', 'Approved with']);
      expect(mounted.container.querySelectorAll('[data-rule-warnings]')).toHaveLength(1);
      expect(flagLines(mounted.container)).toEqual([SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL]);
      expect(q(mounted.container, '[data-rule-warnings]').getAttribute('role')).toBe('note');
      expect(q(mounted.container, '[data-rule-warnings]').querySelector('dl, dt, dd')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the kernel-proof detail in a collapsed expander named "How it\u2019s checked"', async () => {
    const mounted = await mount(card(terminalRule()));
    try {
      const checked = q<HTMLDetailsElement>(mounted.container, 'details[data-rule-checked]');
      expect(checked.open).toBe(false);
      expect(q(checked, 'summary').textContent).toBe('How it\u2019s checked');
      expect(checked.textContent).toContain(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT);
      expect(q(mounted.container, '[data-rule-warnings]').textContent).not.toContain(
        SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('says the page limit behind the expander on a page card, with no red block', async () => {
    const mounted = await mount(card(pageRule()));
    try {
      expect(mounted.container.querySelector('[data-rule-warnings]')).toBeNull();
      expect(q(mounted.container, 'details[data-rule-checked]').textContent).toContain(SIGN_IN_RULE_HONEST_LIMIT);
    } finally {
      await mounted.unmount();
    }
  });

  it('gives a code rule its own one-factor sentence as the red block', async () => {
    const mounted = await mount(card(codeRule()));
    try {
      expect(flagLines(mounted.container)).toEqual([SIGN_IN_RULE_TOTP_WARNING]);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the auto-recipe note amber and apart from the red block', async () => {
    const mounted = await mount(card(pageRule({ flags: ['auto-recipe'] })));
    try {
      expect(mounted.container.querySelector('[data-rule-warnings]')).toBeNull();
      expect(q(mounted.container, '[data-rule-flag="auto-recipe"]').getAttribute('role')).toBe('note');
    } finally {
      await mounted.unmount();
    }
  });

  it('has the same red block on a terminal sheet and none on a page sheet', async () => {
    const terminal = await mount(sheet(sudoPlace, { accountName: 'kirin', username: 'kirin', codeAvailable: false }));
    try {
      expect(flagLines(terminal.container)).toEqual([SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL]);
      expect(q(terminal.container, '[data-rule-does]').textContent).toBe(
        "Ferretry types kirin's sudo password for any ferret on kirin-box, without asking.",
      );
    } finally {
      await terminal.unmount();
    }
    const page = await mount(sheet(sitePlace));
    try {
      expect(page.container.querySelector('[data-rule-warnings]')).toBeNull();
    } finally {
      await page.unmount();
    }
  });
});

describe('the page sheet shows its facts as rows', () => {
  it('shows the site, and the pinned code key once the code is ticked', async () => {
    const mounted = await mount(sheet(sitePlace, { codeKey: 'GitHub authenticator', username: 'kirin@atomi.cloud' }));
    try {
      expect(q(mounted.container, '[data-rule-row="Site"] dd').textContent).toBe('github.com');
      expect(mounted.container.querySelector('[data-rule-row="Code key"]')).toBeNull();
      await click(q(mounted.container, '[data-rule-tick="totp"]'));
      expect(q(mounted.container, '[data-rule-row="Code key"] dd').textContent).toBe('GitHub authenticator');
      expect(flagLines(mounted.container)).toEqual([SIGN_IN_RULE_TOTP_WARNING]);
    } finally {
      await mounted.unmount();
    }
  });

  it('says how often the owner signed in themselves, in the create sheet only', async () => {
    const note = async (history: number | undefined, eligible = true) => {
      const mounted = await mount(
        sheet(sitePlace, {
          eligibility: eligible
            ? { signIn: SITE_SIGN_IN, eligible: true, ...(history === undefined ? {} : { history }) }
            : { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' },
        }),
      );
      try {
        return mounted.container.querySelector('[data-rule-note]')?.textContent ?? null;
      } finally {
        await mounted.unmount();
      }
    };
    expect(await note(3)).toBe('You signed in here yourself 3 times.');
    expect(await note(1)).toBe('You signed in here yourself 1 time.');
    expect(await note(0)).toBeNull();
    expect(await note(undefined)).toBeNull();
    expect(await note(undefined, false)).toBeNull();
    const rule = await mount(card(pageRule()));
    try {
      expect(rule.container.querySelector('[data-rule-note]')).toBeNull();
    } finally {
      await rule.unmount();
    }
  });
});
