/**
 * "Don't ask again" after a saved sign-in: what Accounts draws in the Vault's `vault.input-settled` slot. It is only a
 * way to open the owner's own sheet, and it draws only what the daemon proves: the sign-in must belong to the account
 * the tap used, and nothing is believed from the slot's props beyond their ids.
 */

import { describe, expect, it } from 'bun:test';
import { INPUT_SETTLED_SLOT } from '@ferretry/core-vault/contract';
import { SignInRuleOffer } from '../../../app/features/secure-copy/sign-in-rule-offer.tsx';
import { signInRuleOfferPanel } from '../../../app/surfaces.tsx';
import { mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { type RuleWorld, refused, ruleClient } from '../../support/app/sign-in-rule-client.ts';
import { SITE_SIGN_IN } from '../../support/app/sign-in-rule-fixtures.ts';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

/** What the Vault's settled card hands the panel (its `InputSettledSlotProps`, plus the shell's `subject`). */
const SLOT = {
  ferret: 'fy_ferret_pip',
  request: 'ir_0123456789abcdef',
  entry: 'GITHUB',
  signIn: SITE_SIGN_IN,
  place: 'github.com',
  subject: 'fy_ferret_pip',
} as const;

const offer = (
  world: RuleWorld = {},
  slot: Readonly<Record<string, unknown>> = SLOT,
  ask: (() => Promise<boolean>) | null = async () => true,
) => {
  const fake = ruleClient(world);
  return { fake, element: <SignInRuleOffer askPasskey={ask ?? undefined} client={fake.client} slot={slot} /> };
};

describe('the "Don’t ask again" offer after a saved sign-in', () => {
  it('is declared in the Vault’s slot, by the name the Vault owns', () => {
    expect(INPUT_SETTLED_SLOT).toBe('vault.input-settled');
  });

  it('draws one button, naming nothing: not the account, the username, the place or a value', async () => {
    const { element } = offer();
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-offer]').getAttribute('data-rule-offer')).toBe('idle');
      expect(q(mounted.container, '[data-rule-offer-open]').textContent).toBe('Don’t ask again…');
      expect(mounted.container.textContent).not.toContain('kirinnee');
      expect(mounted.container.textContent).not.toContain('github.com');
    } finally {
      await mounted.unmount();
    }
  });

  it('opens the owner’s sheet (origin offer), staging nothing until the owner approves', async () => {
    const { fake, element } = offer();
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-open]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('offer');
      expect(fake.keys()).not.toContain('POST /v1/sign-in-rules/stages');
      // Cancel goes back to the button.
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(q(mounted.container, '[data-rule-offer]').getAttribute('data-rule-offer')).toBe('idle');
    } finally {
      await mounted.unmount();
    }
  });

  it('stages the rule for the sign-in the DAEMON lists, not for anything the slot said, and says it is done', async () => {
    const { fake, element } = offer({}, { ...SLOT, place: 'evil.example' });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-open]'));
      await settle();
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      const staged = fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages');
      expect(staged?.body).toMatchObject({ signIn: SITE_SIGN_IN, fields: ['username', 'password'] });
      expect(JSON.stringify(staged?.body)).not.toContain('evil.example');
      expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(true);
      expect(q(mounted.container, '[data-rule-offer]').getAttribute('data-rule-offer')).toBe('done');
    } finally {
      await mounted.unmount();
    }
  });

  it('offers the asking ferret and its project as scopes only; a project the daemon cannot read is not offered', async () => {
    const withProject = offer({ ferret: { projectId: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09' } });
    const mounted = await mount(withProject.element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-open]'));
      await settle();
      expect(withProject.fake.keys()).toContain('GET /v1/ferrets/fy_ferret_pip');
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing, and reads nothing, when the tap used no sign-in', async () => {
    const { signIn: _signIn, ...bare } = SLOT;
    const { fake, element } = offer({}, bare);
    const mounted = await mount(element);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
      expect(fake.keys().filter(key => key === 'GET /v1/accounts')).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing when the sign-in belongs to another account than the one the tap used', async () => {
    const { element } = offer({}, { ...SLOT, entry: 'VERCEL' });
    const mounted = await mount(element);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing when this machine no longer has that sign-in or account', async () => {
    for (const slot of [
      { ...SLOT, signIn: 'si_00000000000000ff' },
      { ...SLOT, entry: 'NOT_AN_ACCOUNT' },
    ]) {
      const { element } = offer({}, slot);
      const mounted = await mount(element);
      try {
        await settle();
        expect(mounted.container.innerHTML).toBe('');
      } finally {
        await mounted.unmount();
      }
    }
  });

  it('draws nothing on a device the daemon refuses accounts to, or when the read fails', async () => {
    for (const fail of [() => refused('forbidden', { status: 403 }), () => refused('offline')]) {
      const { element } = offer({ fail: key => (key === 'GET /v1/accounts' ? fail() : undefined) });
      const mounted = await mount(element);
      try {
        await settle();
        expect(mounted.container.innerHTML).toBe('');
      } finally {
        await mounted.unmount();
      }
    }
  });

  it('draws nothing from props that are not the slot’s shape (no ferret, request or entry), and reads nothing', async () => {
    for (const slot of [{}, { ferret: 'f', request: 'r' }, { ferret: 1, request: 'r', entry: 'GITHUB' }]) {
      const { fake, element } = offer({}, slot);
      const mounted = await mount(element);
      try {
        await settle();
        expect(mounted.container.innerHTML).toBe('');
        expect(fake.calls).toEqual([]);
      } finally {
        await mounted.unmount();
      }
    }
  });

  it('cannot approve on a device that cannot ask for a passkey: the sheet says so and stages nothing', async () => {
    const { fake, element } = offer({}, SLOT, null);
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-offer-open]'));
      await settle();
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-approve]').disabled).toBe(true);
      expect(fake.keys()).not.toContain('POST /v1/sign-in-rules/stages');
    } finally {
      await mounted.unmount();
    }
  });

  it('is the panel the app half hands the shell for that slot: its props in, the same offer out', async () => {
    const fake = ruleClient();
    const Panel = signInRuleOfferPanel(fake.client);
    const mounted = await mount(<Panel {...SLOT} />);
    try {
      await settle();
      expect(q(mounted.container, '[data-rule-offer]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
  });
});
