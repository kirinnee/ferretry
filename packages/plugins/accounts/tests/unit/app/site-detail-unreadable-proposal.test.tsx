/**
 * G7 / ledger A-31 recheck item 1: a proposal the daemon could not mask is an EXPLICIT state (`unreadable`), and Settings
 * offers no Approve for it (only Decline), exactly as the ask card does. Synthetic data only.
 */

import { describe, expect, it } from 'bun:test';
import { SiteDetail } from '../../../app/features/accounts/site-detail.tsx';
import { RECIPE_CARD_WORDS } from '../../../app/lib/recipe-proposal-card.ts';
import { AccountListSchema } from '../../../contract/routes/index.ts';
import { mount } from '../../support/app/dom.ts';

const AT = '2026-10-31T10:00:00.000Z';
const SI = 'si_0000000000000001';

const served = (proposal: Record<string, unknown>) =>
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
        recipe: 'Press Sign in',
        recipeVersion: 1,
        createdAt: AT,
        updatedAt: AT,
        proposals: [{ id: 'rp_0123456789abcdef', why: 'w', sessionId: 's', proposedAt: AT, ...proposal }],
      },
    ],
  });

const drawn = async (proposal: Record<string, unknown>) => {
  const list = served(proposal);
  return await mount(
    <SiteDetail
      account={list.accounts[0] as never}
      accounts={list.accounts as never}
      busy={false}
      defaults={{ status: 'ready', defaults: {} } as never}
      error={null}
      onClosed={() => undefined}
      onTab={() => undefined}
      ops={{} as never}
      signIn={list.signIns[0] as never}
      tab="recipe"
    />,
  );
};

describe('Settings and a proposal the daemon could not show', () => {
  it('offers Approve for a readable proposal, and only Decline (with the words) for an unreadable one', async () => {
    const readable = await drawn({
      recipe: 'Press Sign in\nChoose the passkey',
      base: 'Press Sign in',
      pin: 'a'.repeat(64),
    });
    try {
      expect(readable.container.querySelector('[data-accounts-proposal-approve]')).not.toBeNull();
    } finally {
      await readable.unmount();
    }
    const unreadable = await drawn({ recipe: 'x', unreadable: true });
    try {
      expect(unreadable.container.querySelector('[data-accounts-proposal-approve]')).toBeNull();
      expect(unreadable.container.querySelector('[data-accounts-proposal-decline]')).not.toBeNull();
      expect(unreadable.container.textContent).toContain(RECIPE_CARD_WORDS.unreadable);
    } finally {
      await unreadable.unmount();
    }
  });
});
