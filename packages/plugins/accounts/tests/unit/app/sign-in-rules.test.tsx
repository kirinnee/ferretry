/** The standing sign-in rule screens: sheet, card and Settings surface. */

import { describe, expect, it } from 'bun:test';
import { SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TOTP_WARNING } from '../../../contract/routes/index.ts';
import { SignInRuleCard } from '../../../app/features/accounts/sign-in-rule-card.tsx';
import { SignInRuleSheet } from '../../../app/features/accounts/sign-in-rule-sheet.tsx';
import { MachineRuleStage, SignInRulesSurface } from '../../../app/features/secure-copy/sign-in-rules-surface.tsx';
import { answeredClient } from '../../support/app/fake-client.ts';
import { INELIGIBLE_WORDS, RULE_NO_ACCOUNTS_DEVICE_WORDS } from '../../../app/lib/sign-in-rules.ts';
import { interact, mount, must } from '../../support/app/dom.ts';
import {
  CODE_KEY,
  codeRule,
  machineStage,
  pageRule,
  ruleList,
  SITE_SIGN_IN,
  STAGE_ID,
  sitePlace,
  sudoPlace,
  suspendedRule,
  terminalRule,
} from '../../support/app/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const all = (root: ParentNode, selector: string): readonly HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(selector));

const eligible = { signIn: SITE_SIGN_IN, eligible: true } as const;

const sheet = (extra: Partial<Parameters<typeof SignInRuleSheet>[0]> = {}) => (
  <SignInRuleSheet
    accountName="github work"
    autoRecipe={false}
    canUsePasskey
    codeAvailable
    eligibility={eligible}
    onApprove={() => undefined}
    onCancel={() => undefined}
    origin="owner"
    phase={{ kind: 'idle' }}
    place={sitePlace}
    scopes={[{ kind: 'any' }]}
    username="kirin@atomi.cloud"
    {...extra}
  />
);

describe('the create sheet', () => {
  it('ticks nothing when a ferret suggested it, and keeps Approve off', async () => {
    const mounted = await mount(sheet({ origin: 'suggestion' }));
    try {
      for (const tick of all(mounted.container, '[data-rule-tick]'))
        expect((tick as HTMLInputElement).checked).toBe(false);
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('needs the red acknowledgement before the code can be approved', async () => {
    const mounted = await mount(sheet());
    try {
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-rule-tick="totp"]').click());
      expect(q(mounted.container, '[data-rule-flag="one-factor"]').textContent).toBe(SIGN_IN_RULE_TOTP_WARNING);
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
      await interact(() => q<HTMLInputElement>(mounted.container, '[data-rule-tick="totp-ack"]').click());
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows the root flag, the program limit and the password-only terminal rule from the place kind', async () => {
    const mounted = await mount(
      sheet({ place: sudoPlace, username: undefined, codeAvailable: false, eligibility: { ...eligible } }),
    );
    try {
      expect(q(mounted.container, '[data-rule-flag="root"]').textContent).toBe(SIGN_IN_RULE_ROOT_WARNING);
      expect(mounted.container.querySelectorAll('[data-rule-warnings]')).toHaveLength(1);
      expect(mounted.container.querySelector('[data-rule-tick="username"]')).toBeNull();
      expect(mounted.container.querySelector('[data-rule-tick="totp"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps both detail lists closed until they are opened', async () => {
    const mounted = await mount(
      sheet({ place: sudoPlace, username: undefined, codeAvailable: false, eligibility: { ...eligible } }),
    );
    try {
      for (const hook of ['[data-rule-checked]', '[data-rule-still-asked]'])
        expect((q(mounted.container, hook) as HTMLDetailsElement).open).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('says why a sign-in cannot have a rule and offers no tick', async () => {
    const mounted = await mount(
      sheet({ eligibility: { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' } }),
    );
    try {
      expect(q(mounted.container, '[data-rule-ineligible]').textContent).toContain(INELIGIBLE_WORDS['no-history']);
      expect(mounted.container.querySelector('[data-rule-tick]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('makes every checkbox row at least 44px tall for a thumb', async () => {
    const mounted = await mount(sheet());
    try {
      for (const tick of all(mounted.container, '[data-rule-tick]'))
        expect(tick.closest('label')?.className).toContain('min-h-[44px]');
    } finally {
      await mounted.unmount();
    }
  });

  it('says a dismissed passkey approved nothing', async () => {
    const mounted = await mount(sheet({ phase: { kind: 'dismissed' } }));
    try {
      expect(q(mounted.container, '[data-rule-dismissed]').textContent).toContain('nothing was approved');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the rule card', () => {
  const card = (rule = pageRule()) => (
    <SignInRuleCard
      busy={false}
      canUsePasskey
      onNarrow={() => undefined}
      onReapprove={() => undefined}
      onRevoke={() => undefined}
      rule={rule}
    />
  );

  it('flags a code rule from the flags array and names the code once', async () => {
    const mounted = await mount(card(codeRule()));
    try {
      expect(q(mounted.container, '[data-rule-flag="one-factor"]').textContent).toContain(SIGN_IN_RULE_TOTP_WARNING);
      expect(q(mounted.container, '[data-rule-row="Types"]').textContent).toContain('2FA code');
      expect(q(mounted.container, '[data-rule-row="Code key"]').textContent).toContain(CODE_KEY);
      expect(mounted.container.querySelectorAll('[data-rule-row="Code key"]')).toHaveLength(1);
      expect(q(mounted.container, '[data-rule-row="Account"]').textContent).toContain(
        'gitlab work · kirin@atomi.cloud',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('flags a terminal rule root', async () => {
    const mounted = await mount(card(terminalRule()));
    try {
      expect(q(mounted.container, '[data-rule-flag="root"]').textContent).toBe(SIGN_IN_RULE_ROOT_WARNING);
    } finally {
      await mounted.unmount();
    }
  });

  it('offers resume only with a passkey, and no narrow on a suspended rule', async () => {
    const mounted = await mount(card(suspendedRule()));
    try {
      expect(q(mounted.container, '[data-rule-status-words]').textContent).toContain('Suspended');
      expect(mounted.container.querySelector('[data-rule-resume]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-rule-narrow]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

describe('Settings › Secure copy', () => {
  const fake = (answers: () => unknown) => {
    const calls: string[] = [];
    const { client } = answeredClient({
      'GET /v1/sign-in-rules': () => {
        calls.push('GET /v1/sign-in-rules');
        const answer = answers();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    return { client, calls };
  };

  it('draws a machine-staged terminal rule with the root flag from the boolean,', async () => {
    const { client, calls } = fake(() => ruleList({ stages: [machineStage()] }));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={60_000} />);
    try {
      expect(q(mounted.container, '[data-rule-stage]').getAttribute('data-rule-stage')).toBe(STAGE_ID);
      expect(q(mounted.container, '[data-rule-flag="root"]').textContent).toContain(SIGN_IN_RULE_ROOT_WARNING);
      expect(calls).toEqual(['GET /v1/sign-in-rules']);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a clear sentence and no names on a 403 device, and stops asking', async () => {
    const { client, calls } = fake(() => Object.assign(new Error('forbidden'), { status: 403 }));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={10} />);
    try {
      expect(q(mounted.container, '[data-sign-in-rules-forbidden]').textContent).toBe(RULE_NO_ACCOUNTS_DEVICE_WORDS);
      expect(mounted.container.querySelector('[data-rule]')).toBeNull();
      await interact(async () => await new Promise(resolve => setTimeout(resolve, 120)));
      expect(calls).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps asking after an ordinary failure', async () => {
    const { client, calls } = fake(() => new Error('offline'));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={10} />);
    try {
      expect(q(mounted.container, '[data-sign-in-rules-error]').textContent).toContain('offline');
      await interact(async () => await new Promise(resolve => setTimeout(resolve, 120)));
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('lists a rule and says the file is damaged when it is', async () => {
    const { client } = fake(() => ruleList({ health: 'damaged', rules: [pageRule()] }));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={60_000} />);
    try {
      expect(mounted.container.querySelector('[data-rule-damaged]')).not.toBeNull();
      expect(mounted.container.querySelectorAll('[data-rule]')).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('a machine’s rule on its own', () => {
  const idle = { kind: 'idle' } as const;

  it('draws the root block and asks for the passkey on confirm', async () => {
    let confirmed = 0;
    const mounted = await mount(
      <MachineRuleStage
        canUsePasskey
        onConfirm={() => {
          confirmed += 1;
        }}
        onDeny={() => undefined}
        phase={idle}
        staged={machineStage()}
      />,
    );
    try {
      expect(q(mounted.container, '[data-rule-machine]').textContent).toContain('A machine asked for this rule');
      await interact(() => q<HTMLButtonElement>(mounted.container, '[data-rule-machine-confirm]').click());
      expect(confirmed).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('cannot be confirmed on a device with no passkey', async () => {
    const mounted = await mount(
      <MachineRuleStage
        canUsePasskey={false}
        onConfirm={() => undefined}
        onDeny={() => undefined}
        phase={idle}
        staged={machineStage()}
      />,
    );
    try {
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-machine-confirm]').disabled).toBe(true);
      expect(q(mounted.container, '[data-rule-no-passkey]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });
});
