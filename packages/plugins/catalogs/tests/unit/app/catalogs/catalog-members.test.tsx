import { beforeEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { CatalogMembersPanel } from '../../../../app/features/catalogs/catalog-members.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../support/catalog-client.ts';
import {
  KEY_A1,
  MEMBER_A,
  MEMBER_B,
  memberView,
  SHARE_1,
  SHARE_2,
  shareView,
  T0_MS,
} from '../support/catalog-sharing.ts';
import { CATALOG, ownedCatalog } from '../support/catalog-views.ts';
import { mount } from '@ferretry/app/testing';
import { click, settle, typeInto } from '../support/dom-form.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

async function open(handlers: Parameters<typeof fakeClient>[0] = {}) {
  const fake = fakeClient({
    'GET /v1/catalog-members': () => ({ members: [memberView()] }),
    'GET /v1/catalog-shares': () => ({ shares: [shareView()] }),
    ...handlers,
  });
  const back: string[] = [];
  const view = await mount(
    <CatalogMembersPanel
      connection={connection}
      createClient={fake.factory}
      catalogs={[ownedCatalog()]}
      onBack={() => back.push('back')}
      now={() => T0_MS}
      timeZone="UTC"
    />,
  );
  await settle();
  return { fake, view, back };
}

const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};

describe('CatalogMembersPanel', () => {
  it('titles each card by user ID alone, with since, browsers and passkeys, and a real Change user ID button', async () => {
    const { view } = await open();
    expect(q('[data-members-user-id]')?.textContent).toBe('Alice');
    expect(q('[data-members-person="Alice"]')?.textContent).not.toContain('User ID');
    expect(q('[data-members-rename="Alice"]')?.tagName).toBe('BUTTON');
    expect(q('[data-members-rename="Alice"]')?.textContent).toBe('Change user ID');
    expect(q('[data-members-facts]')?.textContent).toBe('since Oct 31 · 2 browsers · 1 passkey');
    await view.unmount();
  });

  it('lists each person with their catalogs and every browser', async () => {
    const { view } = await open();
    expect(q('[data-members-person="Alice"]')).not.toBeNull();
    expect(q('[data-members-catalogs]')?.textContent).toContain('Team skills');
    expect(q('[data-members-browser="Firefox on a Mac"]')?.textContent).toContain('1 passkey');
    expect(q('[data-members-browser="Chrome on a phone"]')?.textContent).toContain('not seen yet');
    await view.unmount();
  });

  it('says so when no one has joined and there are no codes', async () => {
    const { view } = await open({
      'GET /v1/catalog-members': () => ({ members: [] }),
      'GET /v1/catalog-shares': () => ({ shares: [] }),
    });
    expect(q('[data-members-empty]')).not.toBeNull();
    expect(q('[data-shares-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('shows a live code with End now, and a spent one without', async () => {
    const { view } = await open({
      'GET /v1/catalog-shares': () => ({ shares: [shareView(), shareView({ shareId: SHARE_2, state: 'spent' })] }),
    });
    expect(document.querySelectorAll('[data-members-end-share]')).toHaveLength(1);
    expect(q('[data-members-share="spent"]')).not.toBeNull();
    await view.unmount();
  });

  it('lists who used a code', async () => {
    const { view } = await open({
      'GET /v1/catalog-shares': () => ({
        shares: [
          shareView({
            state: 'spent',
            usedBy: [{ clientName: 'Firefox on a Mac', keyId: KEY_A1, at: '2026-10-31T09:01:00.000Z' }],
          }),
        ],
      }),
    });
    expect(q('[data-members-used-by]')?.textContent).toContain('Firefox on a Mac');
    await view.unmount();
  });

  it('ends a code and reads the lists again', async () => {
    let listed = 0;
    const { view, fake } = await open({
      'GET /v1/catalog-shares': () => {
        listed += 1;
        return { shares: listed === 1 ? [shareView()] : [] };
      },
      [`DELETE /v1/catalog-shares/${SHARE_1}`]: () => shareView({ state: 'ended' }),
    });
    await tap('[data-members-end-share]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(q('[data-members-note]')?.textContent).toContain('ended');
    expect(q('[data-shares-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('says what a revoke does before it does it, and names what stays', async () => {
    const { view, fake } = await open();
    await tap('[data-members-revoke="Alice"]');
    expect(q('[data-members-confirm]')?.textContent).toContain('Alice’s 2 browsers stop working now');
    expect(q('[data-members-confirm]')?.textContent).toContain('already downloaded or installed stays');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(false);
    await tap('[data-members-confirm-no]');
    expect(q('[data-members-confirm]')).toBeNull();
    await view.unmount();
  });

  it('revokes a person after the confirm', async () => {
    const { view, fake } = await open({
      [`DELETE /v1/catalog-members/${MEMBER_A}`]: () => ({ memberId: MEMBER_A, keysRemoved: 2, sharesEnded: 1 }),
    });
    await tap('[data-members-revoke="Alice"]');
    await tap('[data-members-confirm-yes]');
    expect(fake.calls.some(call => call.method === 'DELETE' && call.path.endsWith(MEMBER_A))).toBe(true);
    expect(q('[data-members-note]')?.textContent).toContain('Alice is revoked');
    await view.unmount();
  });

  it('removes one browser after its confirm', async () => {
    const { view, fake } = await open({
      [`DELETE /v1/catalog-members/${MEMBER_A}/keys/${KEY_A1}`]: () => ({ memberId: MEMBER_A, keyId: KEY_A1 }),
    });
    await tap('[data-members-remove-browser="Firefox on a Mac"]');
    expect(q('[data-members-confirm]')?.textContent).toContain('Only this browser stops working');
    await tap('[data-members-confirm-yes]');
    expect(fake.calls.some(call => call.path.endsWith(`/keys/${KEY_A1}`))).toBe(true);
    expect(q('[data-members-note]')?.textContent).toContain('Firefox on a Mac is removed');
    await view.unmount();
  });

  it('takes a catalog away after its confirm', async () => {
    const { view, fake } = await open({
      [`DELETE /v1/catalog-members/${MEMBER_A}/catalogs/${CATALOG}`]: () => ({
        memberId: MEMBER_A,
        catalogId: CATALOG,
      }),
    });
    await tap('[data-members-take-away="Team skills"]');
    expect(q('[data-members-confirm]')?.textContent).toContain('Alice stops seeing it now');
    await tap('[data-members-confirm-yes]');
    expect(fake.calls.some(call => call.path.endsWith(`/catalogs/${CATALOG}`))).toBe(true);
    expect(q('[data-members-note]')?.textContent).toContain('can no longer read Team skills');
    await view.unmount();
  });

  it('says why an act failed and keeps the lists', async () => {
    const { view } = await open({
      [`DELETE /v1/catalog-members/${MEMBER_A}`]: () => {
        throw new DaemonCallError(404, 'member_unknown', 'gone');
      },
    });
    await tap('[data-members-revoke="Alice"]');
    await tap('[data-members-confirm-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('That person is gone');
    expect(q('[data-members-person="Alice"]')).not.toBeNull();
    await view.unmount();
  });

  it('explains Sharing off when an act is refused for it', async () => {
    const { view } = await open({
      [`DELETE /v1/catalog-members/${MEMBER_A}`]: () => {
        throw new DaemonCallError(403, 'grant_device_not_granted', 'off');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    await tap('[data-members-revoke="Alice"]');
    await tap('[data-members-confirm-yes]');
    expect(q('[data-sharing-off]')).not.toBeNull();
    expect(q('[data-members-person="Alice"]')).not.toBeNull();
    await view.unmount();
  });

  it('folds a many-people code into one count and one revoke', async () => {
    const { view } = await open({
      'GET /v1/catalog-shares': () => ({ shares: [shareView({ uses: { kind: 'multi', cap: 50 } })] }),
    });
    expect(q('[data-members-multi]')?.textContent).toContain('0 of 50 used');
    expect(q('[data-members-browsers-folded]')).not.toBeNull();
    expect(q('[data-members-revoke="Alice"]')?.textContent).toContain('Revoke all 2');
    await view.unmount();
  });

  it('offers Try again when the read fails, and explains Sharing off', async () => {
    const failed = await open({
      'GET /v1/catalog-members': () => {
        throw new DaemonCallError(500, 'store_damaged', 'x');
      },
    });
    expect(text()).toContain('could not read its sharing files');
    expect(q('[data-catalog-preview-again]')).not.toBeNull();
    await failed.view.unmount();

    const off = await open({
      'GET /v1/catalog-members': () => {
        throw new DaemonCallError(403, 'grant_device_not_granted', 'off');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    await off.view.unmount();
  });

  it('says what a rename does before it is done, and saves the new user ID', async () => {
    const { view, fake } = await open({
      [`PATCH /v1/catalog-members/${MEMBER_A}`]: () => memberView({ label: 'alicia' }),
    });
    await tap('[data-members-rename="Alice"]');
    expect(q('[data-members-rename="Alice"]')).toBeNull();
    expect(q('[data-members-rename-save]')?.hasAttribute('disabled')).toBe(true);
    await typeInto(q('[data-members-rename-input]'), 'alicia');
    expect(q('[data-members-rename-says]')?.textContent).toBe(
      'Alice becomes alicia. They keep their browsers, passkeys and installs.',
    );
    expect(fake.calls.some(call => call.method === 'PATCH')).toBe(false);
    await tap('[data-members-rename-save]');
    expect(fake.calls.find(call => call.method === 'PATCH')?.body).toEqual({ label: 'alicia' });
    expect(q('[data-members-note]')?.textContent).toContain('Alice is now alicia.');
    expect(q('[data-members-rename-form]')).toBeNull();
    await view.unmount();
  });

  it('refuses a user ID someone else has, before asking the machine', async () => {
    const bob = memberView({ memberId: MEMBER_B, label: 'sam' });
    const { view, fake } = await open({ 'GET /v1/catalog-members': () => ({ members: [memberView(), bob] }) });
    await tap('[data-members-rename="Alice"]');
    await typeInto(q('[data-members-rename-input]'), 'Sam');
    expect(q('[data-members-rename-problem]')?.textContent).toBe(
      'Someone here already has the user ID Sam. Pick another.',
    );
    expect(q('[data-members-rename-save]')?.hasAttribute('disabled')).toBe(true);
    expect(fake.calls.some(call => call.method === 'PATCH')).toBe(false);
    await view.unmount();
  });

  it('shows the machine’s own taken-ID answer on the form and keeps it open', async () => {
    const { view } = await open({
      [`PATCH /v1/catalog-members/${MEMBER_A}`]: () => {
        throw new DaemonCallError(409, 'member_exists', 'taken');
      },
    });
    await tap('[data-members-rename="Alice"]');
    await typeInto(q('[data-members-rename-input]'), 'sam');
    await tap('[data-members-rename-save]');
    expect(q('[data-members-rename-problem]')?.textContent).toBe(
      'Someone here already has the user ID sam. Pick another.',
    );
    expect(q('[data-members-rename-form]')).not.toBeNull();
    await view.unmount();
  });

  it('closes the form and says why when a rename fails another way', async () => {
    const { view } = await open({
      [`PATCH /v1/catalog-members/${MEMBER_A}`]: () => {
        throw new DaemonCallError(404, 'member_unknown', 'gone');
      },
    });
    await tap('[data-members-rename="Alice"]');
    await typeInto(q('[data-members-rename-input]'), 'alicia');
    await tap('[data-members-rename-save]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('That person is gone');
    expect(q('[data-members-rename-form]')).toBeNull();
    await view.unmount();
  });

  it('keeps the old user ID when the owner backs out, and forgets a stale refusal', async () => {
    const { view } = await open({
      [`PATCH /v1/catalog-members/${MEMBER_A}`]: () => {
        throw new DaemonCallError(409, 'member_exists', 'taken');
      },
    });
    await tap('[data-members-rename="Alice"]');
    await typeInto(q('[data-members-rename-input]'), 'sam');
    await tap('[data-members-rename-save]');
    await tap('[data-members-rename-cancel]');
    expect(q('[data-members-rename-form]')).toBeNull();
    await tap('[data-members-rename="Alice"]');
    expect(q('[data-members-rename-problem]')).toBeNull();
    await view.unmount();
  });

  it('goes back', async () => {
    const { view, back } = await open();
    await tap('[data-members-back]');
    expect(back).toEqual(['back']);
    await view.unmount();
  });
});
