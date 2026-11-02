/** A ferret's suggestion and the quiet offer after a hand-tapped sign-in: both only open the owner's own sheet. */

import { describe, expect, it } from 'bun:test';
import { SIGN_IN_RULE_REFUSAL_WORDS } from '@ferretry/protocol';
import { SignInRuleOffer } from '../../../src/features/secure-copy/sign-in-rule-offer.tsx';
import { SignInRuleSuggestionHost } from '../../../src/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { AnsweredSuggestions } from '../../../src/lib/answered-suggestions.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { RULE_NO_ACCOUNTS_DEVICE_WORDS } from '../../../src/lib/sign-in-rules.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { mount, must } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type RuleWorld, refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import { pageRule, RULE_ID, ruleList, SITE_SIGN_IN, suggestion } from '../../support/sign-in-rule-fixtures.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const ref = { signInRuleSuggestion: { suggestion: suggestion().id } };

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
        connection={connection}
        createClient={async () => fake.client}
        item={ref}
        offered
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
      expect(q(mounted.container, '[data-rule-replaces]').textContent).toBe(
        'This sign-in already has a standing rule (Expired). Approving here replaces it.',
      );
      await click(q(mounted.container, '[data-rule-tick="password"]'));
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body).toMatchObject({
        signIn: SITE_SIGN_IN,
        fields: ['password'],
        replaces: RULE_ID,
      });
      expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(true);
      expect(mounted.container.textContent).not.toContain('The sign-in changed');
      expect(done).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('still names the rule it replaces when the rule list cannot be read, in words without its status', async () => {
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
      expect(q(mounted.container, '[data-rule-replaces]').textContent).toBe(
        'This sign-in already has a standing rule. Approving here replaces it.',
      );
      await click(q(mounted.container, '[data-rule-tick="password"]'));
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body?.['replaces']).toBe(RULE_ID);
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

describe('a suggestion the owner answered leaves the Inbox, never the ferret’s agenda (C2)', () => {
  const answeredOf = () => {
    const answered = new AnsweredSuggestions();
    return { answered, has: () => answered.has(answered.getSnapshot(), connection.daemonId, suggestion().id) };
  };

  it('marks it answered on a Dismiss, and closes no agenda card', async () => {
    const { answered, has } = answeredOf();
    const { fake, element } = host({}, { answered });
    const mounted = await mount(element);
    try {
      await settle();
      expect(has()).toBe(false);
      await click(q(mounted.container, '[data-rule-suggestion-dismiss]'));
      await settle();
      expect(has()).toBe(true);
      expect(fake.keys().some(key => key.includes('/agenda'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('marks it answered once a rule is approved from it', async () => {
    const { answered, has } = answeredOf();
    const { element } = host({}, { answered });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-suggestion-review]'));
      await settle();
      await click(q(mounted.container, '[data-rule-tick="password"]'));
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(has()).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('marks one the owner’s list no longer holds (answered elsewhere, or expired)', async () => {
    const { answered, has } = answeredOf();
    const mounted = await mount(host({ suggestions: [] }, { answered }).element);
    try {
      await settle();
      expect(has()).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('offers no Not needed on its card: the agenda refuses a close, and Dismiss says no', () => {
    const item = agendaItem('A9', { kind: 'permission', signInRuleSuggestion: { suggestion: suggestion().id } });
    expect(cardModel(item).dismissInMenu).toBe(false);
    expect(cardModel({ ...item, signInRuleSuggestion: undefined }).dismissInMenu).toBe(true);
  });
});

describe('the offer after a hand-tapped sign-in', () => {
  const offer = (world: RuleWorld, signIn: string = SITE_SIGN_IN) => {
    const fake = ruleClient(world);
    return {
      fake,
      element: (
        <SignInRuleOffer askPasskey={async () => true} client={fake.client} signIn={signIn as typeof SITE_SIGN_IN} />
      ),
    };
  };

  it('reads only the eligibility until the owner taps it', async () => {
    const { fake, element } = offer({});
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-offer-button]').textContent).toContain('Don’t ask again');
      expect(fake.keys().every(key => key.startsWith('GET /v1/sign-in-rules/eligibility'))).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing when eligibility says no or cannot be read', async () => {
    const worlds: readonly RuleWorld[] = [
      { eligibility: { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' } },
      { fail: key => (key.startsWith('GET /v1/sign-in-rules/eligibility') ? refused('offline') : undefined) },
    ];
    for (const world of worlds) {
      const mounted = await mount(offer(world).element);
      try {
        await settle();
        expect(mounted.container.querySelector('[data-rule-offer]')).toBeNull();
      } finally {
        await mounted.unmount();
      }
    }
  });

  it('opens the owner’s sheet with the account’s name, and says it is saved once approved', async () => {
    const { fake, element } = offer({});
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      expect(q(mounted.container, '[data-rule-does]').textContent).toContain(' as GitHub for any ferret');
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(q(mounted.container, '[data-rule-offer-saved]').textContent).toContain('Standing rule saved');
      expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('approves for a sign-in that already has a rule, naming the rule it replaces (C1)', async () => {
    const { fake, element } = offer(withRule);
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body?.['replaces']).toBe(RULE_ID);
      expect(q(mounted.container, '[data-rule-offer-saved]').textContent).toContain('Standing rule saved');
    } finally {
      await mounted.unmount();
    }
  });

  it('goes back to the offer on Cancel', async () => {
    const { element } = offer({});
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(q(mounted.container, '[data-rule-offer-button]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });

  it('says the sign-in is gone when it is no longer saved', async () => {
    const { element } = offer({}, 'si_0000000000000099');
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('That sign-in is no longer saved.');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-offer-button]').disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('gives one sentence and no names on a device the daemon refuses', async () => {
    const { element } = offer({
      fail: key => (key === 'GET /v1/accounts' ? refused('forbidden', { status: 403 }) : undefined),
    });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe(RULE_NO_ACCOUNTS_DEVICE_WORDS);
    } finally {
      await mounted.unmount();
    }
  });

  it('says the daemon’s message for any other failure', async () => {
    const { element } = offer({
      fail: key => (key === 'GET /v1/accounts' ? refused('the daemon is offline') : undefined),
    });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-button]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('the daemon is offline');
    } finally {
      await mounted.unmount();
    }
  });
});
