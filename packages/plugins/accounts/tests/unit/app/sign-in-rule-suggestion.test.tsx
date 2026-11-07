/** A ferret's suggestion: it only opens the owner's own sheet. */

import { describe, expect, it } from 'bun:test';
import { SIGN_IN_RULE_REFUSAL_WORDS } from '../../../contract/routes/index.ts';
import { SignInRuleSuggestionHost } from '../../../app/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { RULE_NO_ACCOUNTS_DEVICE_WORDS, RULE_REPLACED_UNREADABLE_WORDS } from '../../../app/lib/sign-in-rules.ts';
import { mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { type RuleWorld, refused, ruleClient } from '../../support/app/sign-in-rule-client.ts';
import {
  pageRule,
  RULE_ID,
  ruleList,
  SITE_SIGN_IN,
  suggestion,
  suspendedRule,
} from '../../support/app/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const SUGGESTION = suggestion().id;

/**
 * A sign-in that already has a standing rule (here one that ran out), and a daemon that refuses a second rule for it
 * exactly as the real stage does (C1): only an approval that names the rule it replaces is staged.
 */
const withRule: RuleWorld = {
  eligibility: { signIn: SITE_SIGN_IN, eligible: true, history: 2, rule: RULE_ID },
  list: ruleList({ rules: [pageRule({ status: 'expired' })] }),
  fail: (key, body) =>
    key === 'POST /v1/sign-in-rules/stages' && body?.['replaces'] !== RULE_ID
      ? refused(SIGN_IN_RULE_REFUSAL_WORDS.rule_exists, { status: 409, code: 'rule_exists' })
      : undefined,
};

const host = (
  world: RuleWorld,
  props: Partial<Parameters<typeof SignInRuleSuggestionHost>[0]> = {},
  ask: (() => Promise<boolean>) | null = async () => true,
) => {
  const fake = ruleClient(world);
  return {
    fake,
    element: (
      <SignInRuleSuggestionHost
        askPasskey={ask ?? undefined}
        client={fake.client}
        suggestionId={SUGGESTION}
        {...props}
      />
    ),
  };
};

describe('a ferret’s suggestion', () => {
  it('names the ferret, the account and the host from the secrets-gated routes, with the reason as the ferret’s', async () => {
    const { element } = host({}, { agentName: 'Pip' });
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-suggestion]').getAttribute('data-rule-suggestion')).toBe(suggestion().id);
      expect(q(mounted.container, '[data-rule-suggestion-subject]').textContent).toBe(
        'Pip suggests a standing rule for GitHub on github.com.',
      );
      expect(q(mounted.container, '[data-rule-suggestion-why]').textContent).toBe(
        'Pip says: “I sign in here on every task.”',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('calls the ferret “The ferret” when it has no name', async () => {
    const { element } = host({});
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-suggestion-subject]').textContent).toStartWith('The ferret suggests');
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing while the daemon has no such suggestion', async () => {
    const { element } = host({ suggestions: [] });
    const mounted = await mount(element);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows one sentence and no names on a device the daemon refuses, asking once', async () => {
    const { fake, element } = host({ fail: () => refused('forbidden', { status: 403 }) });
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-suggestion-forbidden]').textContent).toBe(RULE_NO_ACCOUNTS_DEVICE_WORDS);
      expect(mounted.container.querySelector('[data-rule-suggestion]')).toBeNull();
      expect(mounted.container.textContent).not.toContain('GitHub');
      expect(fake.calls).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('says why the suggestion could not be read', async () => {
    const { element } = host({ fail: () => refused('the daemon is offline') });
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('the daemon is offline');
    } finally {
      await mounted.unmount();
    }
  });

  it('says the sign-in is gone and cannot be reviewed when it is no longer saved', async () => {
    const { element } = host({ suggestions: [suggestion({ signIn: 'si_0000000000000099' })] });
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-suggestion-subject]').textContent).toBe(
        'That sign-in is no longer saved.',
      );
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-suggestion-review]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('dismisses it with a DELETE and tells its owner', async () => {
    let done = 0;
    const { fake, element } = host({}, { onDone: () => (done += 1) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-dismiss]'));
      await settle();
      expect(fake.keys()).toContain(`DELETE /v1/sign-in-rules/suggestions/${suggestion().id}`);
      expect(done).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the card and says why when dismissing fails', async () => {
    let done = 0;
    const { element } = host(
      { fail: key => (key.startsWith('DELETE') ? refused('could not dismiss') : undefined) },
      { onDone: () => (done += 1) },
    );
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-dismiss]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('could not dismiss');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-suggestion-dismiss]').disabled).toBe(false);
      expect(done).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('opens the owner’s sheet with nothing ticked, and Cancel goes back to the card', async () => {
    const { element } = host({});
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('suggestion');
      for (const tick of mounted.container.querySelectorAll<HTMLInputElement>('[data-rule-tick]'))
        expect(tick.checked).toBe(false);
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(q(mounted.container, '[data-rule-suggestion]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('stages only what the owner ticks and tells its owner once it is approved', async () => {
    let done = 0;
    const { fake, element } = host({}, { onDone: () => (done += 1) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      await click(q(mounted.container, '[data-rule-tick="password"]'));
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body).toMatchObject({
        signIn: SITE_SIGN_IN,
        fields: ['password'],
      });
      expect(done).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('approves a rule for a sign-in that already has one, as that rule’s renewal, never as a second rule (C1)', async () => {
    let done = 0;
    const { fake, element } = host(withRule, { onDone: () => (done += 1) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      // The old terms are on screen, and an ended rule opens as its renewal, from what it allowed (A-L5).
      expect(q(mounted.container, '[data-rule-replaces]').textContent).toContain(
        'This sign-in already has a standing rule (Expired). Approving here replaces it. It allows now:',
      );
      expect(q(mounted.container, '[data-rule-replaces-rows]').textContent).toContain('Who');
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('renew');
      expect(q<HTMLInputElement>(mounted.container, '[data-rule-tick="password"]').checked).toBe(true);
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body).toMatchObject({
        signIn: SITE_SIGN_IN,
        fields: ['username', 'password'],
        replaces: RULE_ID,
      });
      expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(true);
      expect(mounted.container.textContent).not.toContain('The sign-in changed');
      expect(done).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('replaces nothing it cannot show: a rule list that cannot be read stops the sheet (A-L5)', async () => {
    const world: RuleWorld = {
      ...withRule,
      fail: (key, body) => (key === 'GET /v1/sign-in-rules' ? refused('offline') : withRule.fail?.(key, body)),
    };
    const { fake, element } = host(world);
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe(RULE_REPLACED_UNREADABLE_WORDS);
      expect(mounted.container.querySelector('[data-rule-approve]')).toBeNull();
      expect(fake.keys()).not.toContain('POST /v1/sign-in-rules/stages');
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(q(mounted.container, '[data-rule-suggestion]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('starts a replace of an active rule from its own scope and cap, never wider defaults (A-L5)', async () => {
    const scoped = pageRule({
      scope: { kind: 'project', project: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09' },
      uses: 5,
      remaining: 5,
    } as never);
    const world: RuleWorld = { ...withRule, list: ruleList({ rules: [scoped] }) };
    const { fake, element } = host(world);
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q(mounted.container, '[data-rule-replaces]').getAttribute('data-rule-replaces')).toBe('active');
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body).toMatchObject({
        scope: { kind: 'project', project: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09' },
        uses: 5,
        replaces: RULE_ID,
      });
    } finally {
      await mounted.unmount();
    }
  });

  it('opens a replace of a suspended rule as its resume', async () => {
    const world: RuleWorld = { ...withRule, list: ruleList({ rules: [suspendedRule()] }) };
    const mounted = await mount(host(world).element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('resume');
      expect(q(mounted.container, '[data-rule-replaces]').getAttribute('data-rule-replaces')).toBe('suspended');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a reading line until the rule it replaces is read', async () => {
    let answer: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      answer = resolve;
    });
    const fake = ruleClient(withRule);
    const slow = {
      call: async (route: string, init?: never) => {
        if (route === 'GET /v1/sign-in-rules') await gate;
        return await fake.client.call(route, init);
      },
    } as never;
    const mounted = await mount(host(withRule, { client: slow }).element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q(mounted.container, '[data-rule-replaces-reading]').textContent).toContain('Reading the standing rule');
      answer();
      await settle();
      expect(q(mounted.container, '[data-rule-replaces]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('cannot be approved on a device with no passkey', async () => {
    const { element } = host({}, {}, null);
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});
