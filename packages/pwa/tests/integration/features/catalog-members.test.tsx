import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogMembersPanel } from '../../../src/features/catalogs/catalog-members.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../support/catalog-client.ts';
import { KEY_A1, MEMBER_A, memberView, SHARE_1, SHARE_2, shareView, T0_MS } from '../../support/catalog-sharing.ts';
import { CATALOG, ownedCatalog } from '../../support/catalog-views.ts';
import { mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
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
        throw new FyHttpError('gone', 404, 'member_unknown');
      },
    });
    await tap('[data-members-revoke="Alice"]');
    await tap('[data-members-confirm-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('That person is gone');
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
        throw new FyHttpError('x', 500, 'store_damaged');
      },
    });
    expect(text()).toContain('could not read its sharing files');
    expect(q('[data-catalog-preview-again]')).not.toBeNull();
    await failed.view.unmount();

    const off = await open({
      'GET /v1/catalog-members': () => {
        throw new FyHttpError('off', 403, 'grant_device_not_granted');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    await off.view.unmount();
  });

  it('goes back', async () => {
    const { view, back } = await open();
    await tap('[data-members-back]');
    expect(back).toEqual(['back']);
    await view.unmount();
  });
});
