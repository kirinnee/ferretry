import { beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { ShareSheet } from '../../../../src/features/catalogs/share-sheet.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import {
  FAKE_CODE,
  FAKE_LINK,
  MEMBER_A,
  memberView,
  mintResponse,
  SHARE_1,
  shareView,
  T0_MS,
} from '../../../support/catalog-sharing.ts';
import { ownedCatalog } from '../../../support/catalog-views.ts';
import { mount } from '../../../support/dom.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
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
  it('asks for a name and keeps the passkey button off until there is one', async () => {
    const { view } = await open({});
    expect(q('[data-share-confirm]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-share-problem]')?.textContent).toContain('Type the name');
    await typeInto(q('[data-share-name]'), 'Carol');
    expect(q('[data-share-confirm]')?.hasAttribute('disabled')).toBe(false);
    expect(q('[data-share-confirm]')?.textContent).toContain('Confirm with passkey');
    await view.unmount();
  });

  it('shows the existing-member warning before anything is minted', async () => {
    const { view, fake } = await open({});
    await choose('[data-share-who-existing]');
    expect(q('[data-share-existing-warning]')?.textContent).toContain('read everything Alice can read');
    expect(fake.calls.some(call => call.method === 'POST')).toBe(false);
    expect(q('[data-share-uses-multi]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-share-many-note]')).not.toBeNull();
    await view.unmount();
  });

  it('disables "someone already in" when no one has joined', async () => {
    const { view } = await open({ 'GET /v1/catalog-members': () => ({ members: [] }) });
    expect(q('[data-share-who-existing]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-share-no-members]')).not.toBeNull();
    await view.unmount();
  });

  it('asks for a cap when many people may join, and sends the choices', async () => {
    const response = mintResponse({ share: shareView({ uses: { kind: 'multi', cap: 30 } }) });
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => response });
    await typeInto(q('[data-share-name]'), 'Crew');
    await choose('[data-share-uses-multi]');
    expect((q('[data-share-cap]') as HTMLInputElement).value).toBe('50');
    await typeInto(q('[data-share-cap]'), '1');
    expect(q('[data-share-problem]')?.textContent).toContain('2 to 200');
    await typeInto(q('[data-share-cap]'), '30');
    const select = q('[data-share-expiry]') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['15m', '1h', '3h', '8h', '1d']);
    await choose('[data-share-confirm]');
    const minted = fake.calls.find(call => call.method === 'POST');
    expect(minted?.body).toMatchObject({ member: { kind: 'new', label: 'Crew' }, uses: { kind: 'multi', cap: 30 } });
    await view.unmount();
  });

  it('says what went wrong, with the next step, when the machine refuses', async () => {
    const { view } = await open({
      'POST /v1/catalog-shares': () => {
        throw new FyHttpError('no', 409, 'members_full');
      },
    });
    await typeInto(q('[data-share-name]'), 'Carol');
    await choose('[data-share-confirm]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Revoke someone first');
    expect(q('[data-share-link]')).toBeNull();
    await view.unmount();
  });

  it('explains Sharing being off instead of the form', async () => {
    const { view } = await open({
      'GET /v1/catalog-members': () => {
        throw new FyHttpError('off', 403, 'grant_device_not_granted');
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
        throw new FyHttpError('off', 403, 'grant_device_not_granted');
      },
      'GET /v1/devices': () => ({ devices: [] }),
    });
    await typeInto(q('[data-share-name]'), 'Carol');
    await choose('[data-share-confirm]');
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });
});

describe('ShareSheet result', () => {
  const minted = { 'POST /v1/catalog-shares': () => mintResponse() };
  const makeLink = async (extra: Record<string, unknown> = {}, handlers = minted) => {
    const opened = await open(handlers, extra);
    await typeInto(q('[data-share-name]'), 'Carol');
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
          throw new FyHttpError('gone', 404, 'share_unknown');
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

  it('shows a sentence instead of a QR when the link is too long to draw', async () => {
    // Past the largest symbol this app draws (version 20), and still under the wire's 2,048-character link.
    const long = `${FAKE_LINK};pad=${'x'.repeat(1_000)}`;
    const { view } = await makeLink({}, { 'POST /v1/catalog-shares': () => mintResponse({ link: long }) });
    expect(q('[data-share-qr-failure]')?.textContent).toContain('too long');
    expect(q('[data-share-link]')).not.toBeNull();
    await view.unmount();
  });

  it('closes with Done', async () => {
    const { view, closed } = await makeLink();
    await choose('[data-share-done]');
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('mints for an existing person with a single-use code', async () => {
    const { view, fake } = await open({ 'POST /v1/catalog-shares': () => mintResponse() });
    await choose('[data-share-who-existing]');
    await choose('[data-share-confirm]');
    expect(fake.calls.find(call => call.method === 'POST')?.body).toMatchObject({
      member: { kind: 'existing', memberId: MEMBER_A },
      uses: { kind: 'single' },
    });
    await view.unmount();
  });
});
