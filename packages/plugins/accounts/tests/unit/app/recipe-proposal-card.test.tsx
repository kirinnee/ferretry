/**
 * G7 / ledger A-31: a ferret's recipe proposal is approved or declined ON ITS ASK CARD. The card is drawn through the same
 * `ask:sign-in-approval` renderer the chat uses, from the daemon's masked, owner-only account list (never the ask's text), and
 * answers through the owner-only proposal route with the PIN of the text it drew. Synthetic accounts and recipes only.
 */

import { describe, expect, it } from 'bun:test';
import { AccountListSchema } from '../../../contract/routes/index.ts';
import { signInApprovalCard } from '../../../app/surfaces.tsx';
import { RECIPE_CARD_WORDS } from '../../../app/lib/recipe-proposal-card.ts';
import { CONFIRM_TO_SEE_WORDS } from '../../../app/lib/step-up-refusal.ts';
import { mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { fakeClient } from '../../support/app/fake-client.ts';

const AT = '2026-10-31T10:00:00.000Z';
const SI = 'si_0000000000000001';
const RP = 'rp_0123456789abcdef';
const PIN = 'a'.repeat(64);
const DECIDE = 'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId';

const listing = (over: { recipe?: string; base?: string; pin?: string | null; proposed?: boolean } = {}) =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'octo-fixture',
        fields: { password: true },
        factors: [],
        signIns: [SI],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [
      {
        id: SI,
        account: 'GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        recipe: over.recipe ?? 'Open github.com\nPress Sign in',
        recipeVersion: 1,
        createdAt: AT,
        updatedAt: AT,
        ...(over.proposed === false
          ? {}
          : {
              proposals: [
                {
                  id: RP,
                  recipe: 'Open github.com\nPress Sign in\nChoose the passkey',
                  base: over.base ?? 'Open github.com\nPress Sign in',
                  why: 'The page now offers a passkey',
                  sessionId: 'sess-1',
                  proposedAt: AT,
                  ...(over.pin === null ? {} : { pin: over.pin ?? PIN }),
                },
              ],
            }),
      },
    ],
  });

const ask = {
  ref: { kind: 'recipe-proposal', signIn: SI, proposal: RP },
  ferret: 'sess-1',
  ferretName: 'judson',
  subject: 'Recipe change on github.com',
  why: 'x',
};

/** The card as the chat draws it, over a fake daemon answering the account list (and, when asked, the proposal route). */
async function drawn(list: unknown, answer?: (body: unknown) => unknown) {
  const fake = fakeClient(call => (call.route === DECIDE ? (answer?.(call.body) ?? {}) : list));
  const mounted = await mount(<>{signInApprovalCard(fake.client, ask, undefined)}</>);
  await settle();
  return { ...fake, mounted };
}
const button = (container: ParentNode, name: 'approve' | 'decline') =>
  container.querySelector<HTMLElement>(`[data-recipe-proposal-${name}]`);

describe('a ferret’s recipe proposal on its ask card', () => {
  it('draws the account, the place, the ferret’s reason and the WHOLE change, read from the daemon, with Approve and Decline', async () => {
    const { mounted, calls } = await drawn(listing());
    try {
      expect(calls[0]?.route).toBe('GET /v1/accounts');
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('GitHub · octo-fixture · github.com');
      expect(text).toContain('The ferret says: The page now offers a passkey');
      expect(mounted.container.querySelector('[data-diff-op="+"]')?.textContent).toContain('Choose the passkey');
      expect(mounted.container.querySelectorAll('[data-diff-op=" "]').length).toBe(2);
      expect(button(mounted.container, 'approve')).not.toBeNull();
      expect(button(mounted.container, 'decline')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('Approve sends the PIN of the text it drew; Decline sends no pin', async () => {
    const approving = await drawn(listing(), () => listing().signIns[0]);
    try {
      await click(button(approving.mounted.container, 'approve'));
      await settle();
      expect(approving.calls.at(-1)).toMatchObject({
        route: DECIDE,
        path: `/v1/accounts/sign-ins/${SI}/recipe/proposals/${RP}`,
        body: { decision: 'approve', pin: PIN },
      });
      expect(approving.mounted.container.textContent).toContain(RECIPE_CARD_WORDS.approved);
      expect(button(approving.mounted.container, 'approve')).toBeNull();
    } finally {
      await approving.mounted.unmount();
    }
    const declining = await drawn(listing(), () => listing().signIns[0]);
    try {
      await click(button(declining.mounted.container, 'decline'));
      await settle();
      expect(declining.calls.at(-1)?.body).toEqual({ decision: 'decline' });
      expect(declining.mounted.container.textContent).toContain(RECIPE_CARD_WORDS.declined);
    } finally {
      await declining.mounted.unmount();
    }
  });

  it('a recipe that changed since the suggestion offers Decline only, and says why', async () => {
    const { mounted } = await drawn(listing({ recipe: 'Edited by the owner since' }));
    try {
      expect(button(mounted.container, 'approve')).toBeNull();
      expect(button(mounted.container, 'decline')).not.toBeNull();
      expect(mounted.container.textContent).toContain(RECIPE_CARD_WORDS.stale);
    } finally {
      await mounted.unmount();
    }
  });

  it('an answered or replaced proposal says so and offers nothing', async () => {
    const { mounted } = await drawn(listing({ proposed: false }));
    try {
      expect(mounted.container.textContent).toContain(RECIPE_CARD_WORDS.gone);
      expect(mounted.container.querySelector('button')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('a proposal the daemon served without a pin, or a list it cannot read, is never approvable and says where to answer', async () => {
    const unpinned = await drawn(listing({ pin: null }));
    try {
      expect(unpinned.mounted.container.textContent).toContain(RECIPE_CARD_WORDS.unreadable);
      expect(unpinned.mounted.container.querySelector('button')).toBeNull();
    } finally {
      await unpinned.mounted.unmount();
    }
    const failing = fakeClient(() => {
      throw new Error('the daemon is down');
    });
    const mounted = await mount(<>{signInApprovalCard(failing.client, ask, undefined)}</>);
    try {
      await settle();
      expect(mounted.container.textContent).toContain(RECIPE_CARD_WORDS.unreadable);
      expect(mounted.container.querySelector('button')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows the daemon’s refusal in its own words and keeps the buttons, so nothing looks approved', async () => {
    const fake = fakeClient(call => {
      if (call.route === DECIDE) throw Object.assign(new Error('this device may not change secrets'), { status: 403 });
      return listing();
    });
    const mounted = await mount(<>{signInApprovalCard(fake.client, ask, undefined)}</>);
    try {
      await settle();
      await click(button(mounted.container, 'approve'));
      await settle();
      expect(mounted.container.querySelector('[data-recipe-proposal-refused]')?.textContent).toBe(
        'this device may not change secrets',
      );
      expect(button(mounted.container, 'approve')).not.toBeNull();
      expect(mounted.container.textContent).not.toContain(RECIPE_CARD_WORDS.approved);
    } finally {
      await mounted.unmount();
    }
  });

  it('reads quietly on load: a daemon that wants the step-up shows the confirm button, and the press reads again for real', async () => {
    const seen: boolean[] = [];
    const client = {
      call: async (_route: string, init?: { readonly quiet?: boolean }) => {
        seen.push(init?.quiet === true);
        if (init?.quiet === true)
          throw Object.assign(new Error('step-up required'), { status: 403, code: 'grant_step_up_required' });
        return listing();
      },
    };
    const mounted = await mount(<>{signInApprovalCard(client as never, ask, undefined)}</>);
    try {
      await settle();
      expect(seen).toEqual([true]);
      expect(mounted.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
      await click(must(mounted.container.querySelector('[data-confirm-to-see] button'), 'the confirm button'));
      await settle();
      expect(seen).toEqual([true, false]);
      expect(button(mounted.container, 'approve')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('never draws a value: the card is the daemon’s masked text as plain text, so markup and a secret-shaped mask are inert', async () => {
    const hostile = AccountListSchema.parse({
      ...listing(),
      signIns: [
        {
          ...listing().signIns[0],
          proposals: [
            {
              id: RP,
              recipe: '<img src=x onerror=alert(1)>\nType ******** into the password field',
              base: 'Open github.com\nPress Sign in',
              why: '<b>trust me</b>',
              sessionId: 'sess-1',
              proposedAt: AT,
              pin: PIN,
            },
          ],
        },
      ],
    });
    const { mounted } = await drawn(hostile);
    try {
      expect(mounted.container.querySelector('img, b')).toBeNull();
      expect(mounted.container.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(mounted.container.textContent).toContain('Type ******** into the password field');
      // The pin names the proposal to the daemon only: it is never drawn.
      expect(mounted.container.textContent).not.toContain(PIN);
      expect(mounted.container.innerHTML).not.toContain(PIN);
    } finally {
      await mounted.unmount();
    }
  });
});
