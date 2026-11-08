import { beforeEach, describe, expect, it } from 'bun:test';
import { SHARE_LINK_RELAYED_NOTICE } from '../../../../contract/wire/index.ts';
import { DaemonCallError } from '@ferretry/app';
import { ShareSheet } from '../../../../app/features/catalogs/share-sheet.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../support/catalog-client.ts';
import {
  FAKE_CODE,
  FAKE_LINK,
  FAKE_RELAYED_LINK,
  memberView,
  mintResponse,
  SHARE_1,
  shareView,
  T0_MS,
} from '../support/catalog-sharing.ts';
import { ownedCatalog } from '../support/catalog-views.ts';
import { mount } from '@ferretry/app/testing';
import { click, settle, typeInto } from '../support/dom-form.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

async function open(handlers: Parameters<typeof fakeClient>[0], extra: Record<string, unknown> = {}) {
  const fake = fakeClient({ 'GET /v1/catalog-members': () => ({ members: [memberView()] }), ...handlers });
  const closed: string[] = [];
  const copied: string[] = [];
  const view = await mount(
    <ShareSheet
      connection={connection}
      createClient={fake.factory}
      catalog={ownedCatalog()}
      onClose={() => closed.push('closed')}
      now={() => T0_MS}
      copyText={async value => {
        copied.push(value);
      }}
      {...extra}
    />,
  );
  await settle();
  return { fake, view, closed, copied };
}

const choose = async (selector: string) => {
  await click(q(selector));
  await settle();
};

describe('ShareSheet form', () => {
  it('has one field, with its help and a placeholder, and no passkey button until there is an ID', async () => {
    const { view } = await open({});
    const field = q('[data-share-user-id]') as HTMLInputElement;
    expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe('Their user ID');
    expect(field.placeholder).toBe('e.g. alice');
    expect(q('[data-share-user-id-help]')?.textContent).toBe(
      "Unique on this machine. They'll create a passkey under it and sign in with it. The same ID always means the same person.",
    );
    expect(q('[data-share-who-new]')).toBeNull();
    expect(q('[data-share-confirm]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-share-problem]')?.textContent).toContain('Type their user ID');
    await typeInto(q('[data-share-user-id]'), 'carol');
    expect(q('[data-share-confirm]')?.hasAttribute('disabled')).toBe(false);
    expect(q('[data-share-confirm]')?.textContent).toContain('Confirm with passkey');
    await view.unmount();
  });

  it('says a new user ID is new', async () => {
    const { view, fake } = await open({});
    await typeInto(q('[data-share-user-id]'), 'carol');
    expect(q('[data-share-user-id-line]')?.textContent).toBe(
      'New user ID. The person who opens this invite creates a passkey for carol.',
    );
    expect(q('[data-share-user-id-line] strong')?.textContent).toBe('carol');
    expect(q('[data-share-new-passkey]')).toBeNull();
    expect(fake.calls.some(call => call.method === 'POST')).toBe(false);
    await view.unmount();
  });

  it('says an existing user ID reaches the same person, before anything is made', async () => {
    const { view, fake } = await open({}, { catalogs: [ownedCatalog()] });
    await typeInto(q('[data-share-user-id]'), 'alice');
    expect(q('[data-share-user-id-line]')?.textContent).toBe(
      'Alice already has access here (2 browsers · Team skills). This invite reaches the same person: they sign in with their Alice passkey.',
    );
    expect(q('[data-share-user-id-line] strong')?.textContent).toBe('Alice');
    expect(fake.calls.some(call => call.method === 'POST')).toBe(false);
    await view.unmount();
  });

  it('names the catalogs by the one being shared when no list is given', async () => {
    const { view } = await open({});
    await typeInto(q('[data-share-user-id]'), 'alice');
    expect(q('[data-share-user-id-line]')?.textContent).toContain('2 browsers · Team skills');
    await view.unmount();
  });

  it('suggests people already here as you type, and picks one', async () => {
    const { view } = await open({});
    expect(q('[data-share-suggestions]')).toBeNull();
    await typeInto(q('[data-share-user-id]'), 'ali');
    expect([...document.querySelectorAll('[data-share-suggestion]')].map(node => node.textContent)).toEqual(['Alice']);
    await choose('[data-share-suggestion]');
    expect((q('[data-share-user-id]') as HTMLInputElement).value).toBe('Alice');
    expect(q('[data-share-suggestions]')).toBeNull();
    expect(q('[data-share-user-id-line]')?.textContent).toContain('already has access here');
    await view.unmount();
  });

  it('refuses hidden characters in their words and keeps the button off', async () => {
    const { view } = await open({});
    await typeInto(q('[data-share-user-id]'), 'ca\u200brol');
    expect(q('[data-catalog-failure]')?.textContent).toBe(
      "A user ID can't contain hidden or invisible characters. Type it again.",
    );
    expect(q('[data-catalog-failure]')?.getAttribute('role')).toBe('alert');
    expect(q('[data-share-user-id-line]')?.textContent).toBe('');
    expect(q('[data-share-user-id]')?.getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-share-problem]')).toBeNull();
    expect(q('[data-share-confirm]')?.hasAttribute('disabled')).toBe(true);
    expect(text()).not.toContain('\u200b');
    await view.unmount();
  });

  it('offers the new-passkey box only for an existing person on a single-use invite, off until ticked', async () => {
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => mintResponse() });
    await typeInto(q('[data-share-user-id]'), 'alice');
    expect(q('[data-share-new-passkey-box]')?.hasAttribute('checked')).toBe(false);
    expect((q('[data-share-new-passkey-box]') as HTMLInputElement).checked).toBe(false);
    expect(q('[data-share-new-passkey]')?.textContent).toContain('They need a new passkey (lost or new device)');
    expect(q('[data-share-new-passkey-help]')?.textContent).toBe(
      "Only tick this if Alice can't use their passkey any more. Whoever opens this invite can then sign in as Alice.",
    );
    await choose('[data-share-uses-multi]');
    expect(q('[data-share-new-passkey]')).toBeNull();
    await choose('[data-share-uses-single]');
    await choose('[data-share-new-passkey-box]');
    expect((q('[data-share-new-passkey-box]') as HTMLInputElement).checked).toBe(true);
    await choose('[data-share-confirm]');
    expect(fake.calls.find(call => call.method === 'POST')?.body).toMatchObject({
      member: { name: 'alice' },
      uses: { kind: 'single' },
      newPasskey: true,
    });
    await view.unmount();
  });

  it('never asks for a new passkey unless ticked', async () => {
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => mintResponse() });
    await typeInto(q('[data-share-user-id]'), 'alice');
    await choose('[data-share-confirm]');
    const body = fake.calls.find(call => call.method === 'POST')?.body as Record<string, unknown>;
    expect('newPasskey' in body).toBe(false);
    await view.unmount();
  });

  it('pre-ticks it, with its own line, when the person has no passkey left; the owner can still untick', async () => {
    const lost = memberView({ keys: [{ ...(memberView().keys[0] as object), passkeys: 0 }] });
    const { view } = await open({ 'GET /v1/catalog-members': () => ({ members: [lost] }) });
    await typeInto(q('[data-share-user-id]'), 'alice');
    expect((q('[data-share-new-passkey-box]') as HTMLInputElement).checked).toBe(true);
    expect(q('[data-share-new-passkey-help]')?.textContent).toBe(
      'Alice has no passkey left, so this invite lets them create one.',
    );
    await choose('[data-share-new-passkey-box]');
    expect((q('[data-share-new-passkey-box]') as HTMLInputElement).checked).toBe(false);
    expect(q('[data-share-new-passkey-help]')?.textContent).toContain("Only tick this if Alice can't");
    await view.unmount();
  });

  it('asks for a cap when many people may join, and sends the choices', async () => {
    const response = mintResponse({ share: shareView({ uses: { kind: 'multi', cap: 30 } }) });
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => response });
    await typeInto(q('[data-share-user-id]'), 'crew');
    await choose('[data-share-uses-multi]');
    expect((q('[data-share-cap]') as HTMLInputElement).value).toBe('50');
    await typeInto(q('[data-share-cap]'), '1');
    expect(q('[data-share-problem]')?.textContent).toContain('2 to 200');
    await typeInto(q('[data-share-cap]'), '30');
    const select = q('[data-share-expiry]') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['15m', '1h', '3h', '8h', '1d']);
    await choose('[data-share-confirm]');
    const minted = fake.calls.find(call => call.method === 'POST');
    expect(minted?.body).toMatchObject({ member: { name: 'crew' }, uses: { kind: 'multi', cap: 30 } });
    await view.unmount();
  });

  it('says what went wrong, with the next step, when the machine refuses', async () => {
    const { view } = await open({
      'POST /v1/catalog-shares': () => {
        throw new DaemonCallError(409, 'members_full', 'no');
      },
    });
    await typeInto(q('[data-share-user-id]'), 'Carol');
    await choose('[data-share-confirm]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Revoke someone first');
    expect(q('[data-share-link]')).toBeNull();
    await view.unmount();
  });

  it('explains Sharing being off instead of the form', async () => {
    const { view } = await open({
      'GET /v1/catalog-members': () => {
        throw new DaemonCallError(403, 'grant_device_not_granted', 'off');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    expect(q('[data-share-form]')).toBeNull();
    await view.unmount();
  });

  it('shows Sharing off when the mint says so', async () => {
    const { view } = await open({
      'POST /v1/catalog-shares': () => {
        throw new DaemonCallError(403, 'grant_device_not_granted', 'off');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    await typeInto(q('[data-share-user-id]'), 'Carol');
    await choose('[data-share-confirm]');
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });
});

describe('ShareSheet result', () => {
  const minted = { 'POST /v1/catalog-shares': () => mintResponse() };
  const makeLink = async (extra: Record<string, unknown> = {}, handlers = minted) => {
    const opened = await open(handlers, extra);
    await typeInto(q('[data-share-user-id]'), 'Carol');
    await choose('[data-share-confirm]');
    return opened;
  };

  it('shows the link once with a QR, a countdown and the single-use note', async () => {
    const { view } = await makeLink();
    expect(q('[data-share-link]')?.textContent).toBe(FAKE_LINK);
    expect(q('[data-share-qr]')).not.toBeNull();
    expect(q('[data-share-countdown]')?.textContent).toBe('Expires in 1:00:00 · single use');
    expect(text()).toContain('shown once');
    expect(text()).toContain('Carol');
    await view.unmount();
  });

  it('says nothing about a relay beside a link another device dials directly', async () => {
    const { view } = await makeLink();
    expect(q('[data-share-relayed]')).toBeNull();
    await view.unmount();
  });

  it('says the relay carries a link minted on a loopback-only machine, and what the relay can see', async () => {
    const { view } = await makeLink({}, { 'POST /v1/catalog-shares': () => mintResponse({ link: FAKE_RELAYED_LINK }) });
    expect(q('[data-share-link]')?.textContent).toBe(FAKE_RELAYED_LINK);
    expect(q('[data-share-relayed]')?.textContent).toBe(SHARE_LINK_RELAYED_NOTICE);
    expect(q('[data-share-relayed]')?.getAttribute('role')).toBeNull();
    await view.unmount();
  });

  it('never puts the link or the code in a live region or the QR label', async () => {
    const { view } = await makeLink();
    for (const live of document.querySelectorAll('[role="status"], [role="alert"], [aria-live]'))
      expect(live.textContent).not.toContain(FAKE_CODE);
    expect(
      q('[data-share-qr] [aria-label], [data-share-qr] title, [data-share-qr] svg')?.outerHTML ?? '',
    ).not.toContain(FAKE_CODE);
    await view.unmount();
  });

  it('copies the link, and says so', async () => {
    const { view, copied } = await makeLink();
    await choose('[data-share-copy]');
    expect(copied).toEqual([FAKE_LINK]);
    expect(q('[data-share-copy-note]')?.textContent).toContain('Copied');
    await view.unmount();
  });

  it('copies through the browser clipboard when no copier is given', async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (value: string) => void written.push(value) };
    const before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard });
    try {
      const { view } = await makeLink({ copyText: undefined });
      await choose('[data-share-copy]');
      expect(written).toEqual([FAKE_LINK]);
      await view.unmount();
    } finally {
      if (before === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', before);
    }
  });

  it('says to copy by hand when the browser would not', async () => {
    const { view } = await makeLink({
      copyText: async () => {
        throw new Error('blocked');
      },
    });
    await choose('[data-share-copy]');
    expect(q('[data-share-copy-note]')?.textContent).toContain('by hand');
    await view.unmount();
  });

  it('ends the code on request and removes the link from the page', async () => {
    const { view, fake } = await makeLink(
      {},
      {
        ...minted,
        [`DELETE /v1/catalog-shares/${SHARE_1}`]: () => shareView({ state: 'ended' }),
      },
    );
    await choose('[data-share-end]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(q('[data-share-link]')).toBeNull();
    expect(text()).not.toContain(FAKE_CODE);
    expect(q('[data-share-gone]')?.textContent).toContain('ended');
    await view.unmount();
  });

  it('keeps the link and says why when ending fails', async () => {
    const { view } = await makeLink(
      {},
      {
        ...minted,
        [`DELETE /v1/catalog-shares/${SHARE_1}`]: () => {
          throw new DaemonCallError(404, 'share_unknown', 'gone');
        },
      },
    );
    await choose('[data-share-end]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('gone');
    expect(q('[data-share-link]')).not.toBeNull();
    await view.unmount();
  });

  it('drops the link when the clock passes the expiry', async () => {
    let at = T0_MS;
    const { view } = await makeLink({ now: () => at });
    expect(q('[data-share-link]')).not.toBeNull();
    at = T0_MS + 2 * 3_600_000;
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await settle();
    expect(q('[data-share-link]')).toBeNull();
    expect(q('[data-share-gone]')?.textContent).toContain('expired');
    await view.unmount();
  });

  it('N3 draws no QR for a link a phone cannot scan (past version 20), and still shows the link', async () => {
    // The wire caps a link at 2,048 characters; a symbol past version 20 is too dense for a phone camera.
    const long = `${FAKE_LINK};pad=${'x'.repeat(1_500)}`;
    const { view } = await makeLink({}, { 'POST /v1/catalog-shares': () => mintResponse({ link: long }) });
    expect(q('[data-share-qr-failure]')).not.toBeNull();
    expect(q('[data-share-link]')).not.toBeNull();
    await view.unmount();
  });

  it('closes with Done', async () => {
    const { view, closed } = await makeLink();
    await choose('[data-share-done]');
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('mints for an existing person by their user ID, single-use', async () => {
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => mintResponse() });
    await typeInto(q('[data-share-user-id]'), 'ALICE');
    await choose('[data-share-confirm]');
    expect(fake.calls.find(call => call.method === 'POST')?.body).toMatchObject({
      member: { name: 'ALICE' },
      uses: { kind: 'single' },
    });
    expect(text()).toContain('Invite for Alice');
    await view.unmount();
  });

  it('says plainly that a user ID is taken when a multi-use invite names a reserved one', async () => {
    const { view } = await open({
      'POST /v1/catalog-shares': () => {
        throw new DaemonCallError(409, 'member_exists', 'Someone here already has the user ID sam. Pick another.');
      },
    });
    await typeInto(q('[data-share-user-id]'), 'sam');
    await choose('[data-share-uses-multi]');
    expect(q('[data-share-user-id-line]')?.textContent).toContain('New user ID');
    await choose('[data-share-confirm]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Someone here already has the user ID sam.');
    expect(q('[data-share-user-id-line]')?.textContent).toBe('');
    expect(q('[data-share-link]')).toBeNull();
    await view.unmount();
  });
});
