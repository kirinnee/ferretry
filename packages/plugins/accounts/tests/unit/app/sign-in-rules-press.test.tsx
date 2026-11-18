/**
 * Standing sign-in rules poll on their own while the page is open. Only the owner's press on "Confirm it's you" makes a
 * read explicit (it may raise the passkey prompt); a poll, or a reload after an edit, never does, so a step-up window
 * that lapses while the page is open cannot raise a prompt unasked or undo a cancelled one.
 */

import { describe, expect, it } from 'bun:test';
import { SignInRulesSurface } from '../../../app/features/secure-copy/sign-in-rules-surface.tsx';
import { mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { codeRule, pageRule, ruleList } from '../../support/app/sign-in-rule-fixtures.ts';

const POLL_MS = 20;
const LIST = 'GET /v1/sign-in-rules';
const CONFIRM = '[data-confirm-to-see] button';

/** A daemon whose step-up window can lapse: once it has, only a read the owner pressed for (`quiet: false`) is answered. */
const daemon = (lapsed: { value: boolean }, rules: () => ReturnType<typeof ruleList>) => {
  const reads: { readonly quiet: boolean | undefined }[] = [];
  const client = {
    call: async (route: string, init?: { readonly quiet?: boolean }) => {
      if (route === LIST) {
        reads.push({ quiet: init?.quiet });
        if (lapsed.value && init?.quiet !== false)
          throw Object.assign(new Error('step-up required'), { status: 403, code: 'grant_step_up_required' });
        return rules();
      }
      if (route.endsWith('/narrow')) return pageRule();
      throw new Error(`no answer for ${route}`);
    },
  };
  return { client: client as never, reads };
};

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
  await settle();
};

describe('Settings › Standing sign-in rules › who asks for the passkey', () => {
  it('does not prompt on a poll after an edit once the step-up window has lapsed', async () => {
    const lapsed = { value: false };
    const { client, reads } = daemon(lapsed, () => ruleList({ rules: [codeRule()] }));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={POLL_MS} />);
    try {
      await settle();
      await click(must(mounted.container.querySelector('[data-rule-narrow]'), 'narrow'));
      await click(must(mounted.container.querySelector('[data-rule-drop-totp]'), 'drop totp'));
      await click(must(mounted.container.querySelector('[data-rule-narrow-apply]'), 'apply'));
      await settle();
      lapsed.value = true;
      await wait(POLL_MS * 4);
      expect(reads.some(read => read.quiet === false)).toBe(false);
      expect(mounted.container.querySelector(CONFIRM)).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('asks once for the owner’s press, then goes back to quiet polls', async () => {
    const lapsed = { value: true };
    const { client, reads } = daemon(lapsed, () => ruleList({ rules: [codeRule()] }));
    const mounted = await mount(<SignInRulesSurface client={client} pollMs={POLL_MS} />);
    try {
      await settle();
      expect(reads.some(read => read.quiet === false)).toBe(false);
      await click(must(mounted.container.querySelector(CONFIRM), CONFIRM));
      await wait(POLL_MS * 4);
      expect(reads.filter(read => read.quiet === false)).toHaveLength(1);
      expect(reads.at(-1)?.quiet).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});
