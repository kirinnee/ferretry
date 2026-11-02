/** A sign-in's Rule tab: reading the list, making a rule, narrowing, revoking and approving again. */

import { describe, expect, it } from 'bun:test';
import { SIGN_IN_RULE_ERROR_CODES } from '@ferretry/protocol';
import {
  RuleEditWarning,
  SignInRulePanel,
  SignInRuleSheetHost,
} from '../../../src/features/accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../../../src/features/accounts/use-sign-in-rules.ts';
import {
  INELIGIBLE_WORDS,
  RULE_DAMAGED_WORDS,
  RULE_DISMISSED_WORDS,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  suspendWarning,
} from '../../../src/lib/sign-in-rules.ts';
import { list as accountList } from '../../support/accounts-fixtures.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { type RuleWorld, refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import {
  codeRule,
  pageRule,
  RULE_ID,
  ruleList,
  SITE_SIGN_IN,
  sitePlace,
  stagedRule,
  suspendedRule,
} from '../../support/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const accounts = accountList();
const signIn = must(
  accounts.signIns.find(each => each.id === SITE_SIGN_IN),
  'the github sign-in',
);
const account = must(
  accounts.accounts.find(each => each.id === signIn.account),
  'its account',
);

const binding = (
  world: RuleWorld,
  askPasskey: RulesBinding['askPasskey'] = async () => true,
): RulesBinding & { readonly keys: () => string[]; readonly calls: ReturnType<typeof ruleClient>['calls'] } => {
  const fake = ruleClient(world);
  return { client: fake.client, askPasskey, keys: fake.keys, calls: fake.calls };
};

const panel = (rules: RulesBinding) => <SignInRulePanel account={account} rules={rules} signIn={signIn} />;

const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('reading the rules', () => {
  it('says there is no standing rule when the sign-in has none', async () => {
    const rules = binding({});
    const mounted = await mount(panel(rules));
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-none]').textContent).toContain('No standing rule');
      expect(mounted.container.querySelector('[data-rule-honest]')).toBeNull();
      expect(mounted.container.querySelector('[data-rule]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows one sentence and no names on a device the daemon refuses', async () => {
    const rules = binding({ fail: () => refused('forbidden', { status: 403 }) });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-panel="forbidden"]').textContent).toBe(RULE_NO_ACCOUNTS_DEVICE_WORDS);
      expect(mounted.container.textContent).not.toContain('github work');
    } finally {
      await mounted.unmount();
    }
  });

  it('says why the list could not be read', async () => {
    const rules = binding({ fail: () => refused('the daemon is offline') });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-panel="failed"]').textContent).toBe('the daemon is offline');
    } finally {
      await mounted.unmount();
    }
  });

  it('draws this sign-in’s rule, not another’s, and says when the file is damaged', async () => {
    const other = pageRule({ id: `sr_${'e'.repeat(24)}`, signIn: 'si_0000000000000002' });
    const rules = binding({ list: ruleList({ health: 'damaged', rules: [other, pageRule()] }) });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-damaged]').textContent).toBe(RULE_DAMAGED_WORDS);
      expect(mounted.container.querySelectorAll('[data-rule]')).toHaveLength(1);
      expect(q(mounted.container, '[data-rule]').getAttribute('data-rule')).toBe(RULE_ID);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('making a rule', () => {
  it('stages the ticks, asks the passkey, commits, and reads the list again', async () => {
    const asked: string[] = [];
    const rules = binding({}, async (stage, words) => {
      asked.push(stage, words.does);
      return true;
    });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      expect(q(mounted.container, '[data-rule-does]').textContent).toContain(' as GitHub for any ferret');
      expect(rules.keys()).toContain(`GET /v1/sign-in-rules/eligibility?signIn=${SITE_SIGN_IN}`);
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      const stage = must(
        rules.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages'),
        'the stage call',
      );
      expect(stage.body).toMatchObject({
        signIn: SITE_SIGN_IN,
        fields: ['username', 'password'],
        scope: { kind: 'any' },
      });
      expect(stage.body).not.toHaveProperty('replaces');
      expect(asked[0]).toStartWith('srs_');
      expect(rules.keys().filter(key => key === 'GET /v1/sign-in-rules')).toHaveLength(2);
      expect(rules.keys().some(key => key.endsWith('/commit'))).toBe(true);
      expect(mounted.container.querySelector('[data-rule-sheet]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('drops the stage and commits nothing when the passkey is dismissed', async () => {
    const rules = binding({}, async () => false);
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(q(mounted.container, '[data-rule-dismissed]').textContent).toBe(RULE_DISMISSED_WORDS);
      expect(rules.keys().some(key => key.startsWith('DELETE /v1/sign-in-rules/stages/'))).toBe(true);
      expect(rules.keys().some(key => key.endsWith('/commit'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('says the daemon’s sentence when staging is refused', async () => {
    const rules = binding({
      fail: key =>
        key === 'POST /v1/sign-in-rules/stages' ? refused('x', { code: SIGN_IN_RULE_ERROR_CODES.conflict }) : undefined,
    });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toContain('nothing was approved');
      expect(rules.keys().some(key => key.endsWith('/commit'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('says why a sign-in cannot have a rule and offers no approval', async () => {
    const rules = binding({ eligibility: { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' } });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      expect(q(mounted.container, '[data-rule-ineligible]').textContent).toBe(`${INELIGIBLE_WORDS['no-history']}.`);
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('says why eligibility could not be read, and Cancel goes back to the tab', async () => {
    const rules = binding({ fail: key => (key.includes('/eligibility') ? refused('eligibility is down') : undefined) });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('eligibility is down');
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(mounted.container.querySelector('[data-rule-sheet]')).toBeNull();
      expect(q(mounted.container, '[data-rule-start]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('cannot be approved on a device with no passkey', async () => {
    const rules = { ...binding({}), askPasskey: undefined };
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-start]'));
      await settle();
      expect(q(mounted.container, '[data-rule-no-passkey]')).toBeTruthy();
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('a rule that exists', () => {
  it('narrows it with only what the owner took away, then reads the list again', async () => {
    const rules = binding({ list: ruleList({ rules: [codeRule()] }) });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-narrow]'));
      await click(q(mounted.container, '[data-rule-drop-totp]'));
      await typeInto(q(mounted.container, '[data-rule-cap]'), '2');
      await click(q(mounted.container, '[data-rule-narrow-apply]'));
      await settle();
      const narrow = must(
        rules.calls.find(call => call.key === `POST /v1/sign-in-rules/${RULE_ID}/narrow`),
        'the narrow call',
      );
      expect(narrow.body).toEqual({ dropTotp: true, uses: 2 });
      expect(rules.keys().filter(key => key === 'GET /v1/sign-in-rules')).toHaveLength(2);
      expect(mounted.container.querySelector('[data-rule-narrow-form]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows the daemon’s refusal under the card when narrowing fails', async () => {
    const rules = binding({
      list: ruleList({ rules: [pageRule()] }),
      fail: key => (key.endsWith('/narrow') ? refused('cannot narrow that') : undefined),
    });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-narrow]'));
      await typeInto(q(mounted.container, '[data-rule-end-days]'), '3');
      await click(q(mounted.container, '[data-rule-narrow-apply]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('cannot narrow that');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-narrow]').disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('revokes it without a passkey and reads the list again', async () => {
    const rules = { ...binding({ list: ruleList({ rules: [pageRule()] }) }), askPasskey: undefined };
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-revoke]'));
      await settle();
      expect(rules.keys()).toContain(`DELETE /v1/sign-in-rules/${RULE_ID}`);
      expect(rules.keys().filter(key => key === 'GET /v1/sign-in-rules')).toHaveLength(2);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows the daemon’s refusal when revoking fails, and clears it on the next try', async () => {
    let refuse = true;
    const rules = binding({
      list: ruleList({ rules: [pageRule()] }),
      fail: key => (key.startsWith('DELETE') && refuse ? refused('could not revoke') : undefined),
    });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-revoke]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('could not revoke');
      refuse = false;
      await click(q(mounted.container, '[data-rule-revoke]'));
      await settle();
      expect(mounted.container.querySelector('[data-rule-failure]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('resumes a suspended rule through the sheet, replacing it', async () => {
    const rules = binding({ list: ruleList({ rules: [suspendedRule()] }) });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-resume]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('resume');
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      const stage = must(
        rules.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages'),
        'the stage call',
      );
      expect(stage.body).toMatchObject({ replaces: RULE_ID });
    } finally {
      await mounted.unmount();
    }
  });

  it('approves an ended rule again, never ticking the code back on', async () => {
    const rules = binding({
      list: ruleList({ rules: [{ ...codeRule(), status: 'expired' }] }),
      staged: stagedRule({ totp: false }),
    });
    const mounted = await mount(panel(rules));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-renew]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('renew');
      expect(q<HTMLInputElement>(mounted.container, '[data-rule-tick="totp"]').checked).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the sheet host', () => {
  const host = (rules: RulesBinding, extra: Partial<Parameters<typeof SignInRuleSheetHost>[0]> = {}) => (
    <SignInRuleSheetHost
      accountName="github work"
      autoRecipe={false}
      codeAvailable={false}
      onCancel={() => undefined}
      onSettled={() => undefined}
      origin="owner"
      place={sitePlace}
      rules={rules}
      signIn={SITE_SIGN_IN}
      {...extra}
    />
  );

  it('hands the settled rule to its owner and shows progress while it works', async () => {
    const settled: string[] = [];
    let release: (given: boolean) => void = () => undefined;
    const rules = binding(
      {},
      () =>
        new Promise<boolean>(resolve => {
          release = resolve;
        }),
    );
    const mounted = await mount(host(rules, { onSettled: rule => settled.push(rule.id) }));
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(q(mounted.container, '[data-rule-progress]').getAttribute('data-rule-progress')).toBe('passkey');
      await interact(() => release(true));
      await settle();
      expect(settled).toEqual([RULE_ID]);
    } finally {
      await mounted.unmount();
    }
  });

  it('offers the code only for an account with a key, and shows the auto-recipe flag', async () => {
    const rules = binding({});
    const mounted = await mount(host(rules, { codeAvailable: true, autoRecipe: true }));
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-tick="totp"]')).toBeTruthy();
      expect(q(mounted.container, '[data-rule-flag="auto-recipe"]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('sets the days, the cap and who may use it from the controls', async () => {
    const project = '7f1c1a1e-6d0c-4f6e-9a8e-0d3f1f7d2a11';
    const rules = binding({});
    const mounted = await mount(
      host(rules, {
        scopes: [
          { kind: 'project', project },
          { kind: 'session', session: 'ses_abcdefghijklmnop' },
        ],
      }),
    );
    try {
      await settle();
      expect(q<HTMLSelectElement>(mounted.container, '[data-rule-scope]').options).toHaveLength(3);
      await choose(q(mounted.container, '[data-rule-scope]'), `project:${project}`);
      await choose(q(mounted.container, '[data-rule-days]'), '7');
      await typeInto(q(mounted.container, '[data-rule-uses]'), '4');
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      const stage = must(
        rules.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages'),
        'the stage call',
      );
      expect(stage.body).toMatchObject({
        scope: { kind: 'project', project },
        lifetimeSeconds: 7 * 86_400,
        uses: 4,
      });
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the warning on the Method and Recipe tabs', () => {
  it('counts the live rules of this sign-in that a save would suspend', async () => {
    const rules = binding({ list: ruleList({ rules: [pageRule(), codeRule()] }) });
    const mounted = await mount(<RuleEditWarning rules={rules} signIn={SITE_SIGN_IN} />);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-edit-warning]').textContent).toBe(suspendWarning(2));
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing when no live rule would be suspended', async () => {
    const rules = binding({ list: ruleList({ rules: [pageRule({ status: 'expired' })] }) });
    const mounted = await mount(<RuleEditWarning rules={rules} signIn={SITE_SIGN_IN} />);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing when the rules could not be read', async () => {
    const rules = binding({ fail: () => refused('down') });
    const mounted = await mount(<RuleEditWarning rules={rules} signIn={SITE_SIGN_IN} />);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
    } finally {
      await mounted.unmount();
    }
  });
});
