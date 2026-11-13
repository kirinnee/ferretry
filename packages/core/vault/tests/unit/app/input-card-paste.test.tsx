/**
 * The owner's "Allow paste" card (docs/secure-copy.md): a ferret asks to paste a secure copy it holds. There is no field.
 * The owner reads WHAT is pasted (the handle), WHERE it was read and WHERE it goes, and allows or cancels; the body that
 * leaves is `{ sealed: true }`, which names no copy and no value. The only value-shaped string here is the obvious fake.
 */
import { describe, expect, it } from 'bun:test';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import { pasteRoute, sealedBody, titleWords } from '../../../app/lib/input-card.ts';
import { InputRequestViewSchema } from '../../../app/lib/input-wire.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { mount, must } from '../../support/app/dom.ts';
import {
  COPY_SOURCE,
  pageRequest,
  pasteRequest,
  REQUEST_ID,
  recordingClient,
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const DELIVERED = { id: REQUEST_ID, state: 'delivered', submitted: true };
const SENTINEL = 'FAKE-SC-7f3a91';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

async function card(request = pasteRequest(), answer?: () => Promise<unknown>) {
  const rig = recordingClient(async route => {
    if (route.endsWith('/deliver')) return answer === undefined ? DELIVERED : await answer();
    return {};
  });
  const done: string[] = [];
  const mounted = await mount(
    <InputCard client={rig.client} now={NOW} onDone={() => done.push('done')} request={request} />,
  );
  await settle();
  return { ...rig, mounted, done };
}

describe('the paste card’s words', () => {
  it('should read a paste request’s source, which the app used to ignore', () => {
    const read = InputRequestViewSchema.safeParse(pasteRequest());

    expect(read.success).toBe(true);
    expect(read.success && read.data.source).toMatchObject({ kind: 'sealed', name: 'vercel' });
  });

  it('should title a paste as a paste and an ordinary card as what it needs', () => {
    expect(titleWords(pasteRequest(), 'Hadi')).toBe('!A7 · Hadi wants to paste a sealed value');
    expect(titleWords(terminalRequest(), 'Hadi')).toBe('!A7 · Hadi needs a password');
  });

  it('should say where a copy came from and where it goes, from what the daemon saw', () => {
    expect(pasteRoute(pasteRequest())).toEqual({
      from: '/usr/bin/vercel (what it printed)',
      to: 'sudo in %terminal:dev',
    });
    expect(
      pasteRoute(
        pasteRequest({
          target: { kind: 'page', key: 'app' },
          observed: pageRequest().observed,
          source: { ...COPY_SOURCE, from: { kind: 'browser', origin: 'https://vercel.com' } },
        }),
      ),
    ).toEqual({ from: 'https://vercel.com', to: 'a field on https://example.test' });
    expect(
      pasteRoute(
        pasteRequest({
          target: { kind: 'secret', key: 'VERCEL_TOKEN' },
          observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
        }),
      )?.to,
    ).toBe('the secret VERCEL_TOKEN (replacing its value)');
    expect(pasteRoute(terminalRequest())).toBeUndefined();
  });

  it('should send only that the owner allows it: no copy named, no value, the digest the owner saw', () => {
    const built = sealedBody(pasteRequest(), false, 'delivery-1');

    expect(built).toEqual({
      ok: true,
      body: { deliveryId: 'delivery-1', observedDigest: 'b'.repeat(64), sealed: true, submit: false },
    });
    expect(sealedBody(pasteRequest({ observedDigest: undefined }), false, 'delivery-2').ok).toBe(false);
  });
});

describe('the paste card', () => {
  it('should show the copy, where it came from and where it goes, with no field and an Allow paste button', async () => {
    const { mounted } = await card();
    try {
      const root = mounted.container;

      expect(q(root, '[data-input-paste-copy]').textContent).toBe('sealed:vercel');
      expect(q(root, '[data-input-paste-from]').textContent).toBe('/usr/bin/vercel (what it printed)');
      expect(q(root, '[data-input-paste-to]').textContent).toBe('sudo in %terminal:dev');
      expect(root.textContent).toContain('You type nothing');
      expect(root.querySelector('[data-input-value]')).toBeNull();
      expect(root.querySelector('[data-input-send]')).toBeNull();
      expect(q(root, '[data-input-title]').textContent).toBe('!A7 · The ferret wants to paste a sealed value');
      expect(q<HTMLButtonElement>(root, '[data-input-allow]').textContent).toBe('Allow paste');
      expect(root.textContent).not.toContain('Answer it with fy');
    } finally {
      await mounted.unmount();
    }
  });

  it('should allow the paste with a sealed body that carries no value, and settle in words', async () => {
    const { mounted, calls, done } = await card();
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.route).toContain('/deliver');
      expect(calls[0]?.init?.body).toMatchObject({ sealed: true, observedDigest: 'b'.repeat(64) });
      expect(Object.keys(calls[0]?.init?.body as object).sort()).toEqual([
        'deliveryId',
        'observedDigest',
        'sealed',
        'submit',
      ]);
      expect(JSON.stringify(calls)).not.toContain(SENTINEL);
      expect(mounted.container.textContent).toContain('Pasted into %terminal:dev.');
      expect(mounted.container.querySelector('[data-input-allow]')).toBeNull();
      expect(done).toEqual(['done']);
    } finally {
      await mounted.unmount();
    }
  });

  it('should say why a paste was refused (a person took the page over) and keep the card for another try', async () => {
    const { mounted, done } = await card(
      pasteRequest({ target: { kind: 'page', key: 'app' }, observed: pageRequest().observed }),
      async () => {
        throw {
          status: 409,
          code: 'conflict',
          message: 'A person has taken over that page, so nothing is pasted into it.',
        };
      },
    );
    try {
      await click(q(mounted.container, '[data-input-allow]'));
      await settle();

      expect(q(mounted.container, '[data-input-failure]').textContent).toBe(
        'A person has taken over that page, so nothing is pasted into it.',
      );
      expect(done).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it('should keep Allow off while the daemon looks at the target again, and cancel from the card', async () => {
    const { mounted, calls } = await card(pasteRequest({ observed: undefined, observedDigest: undefined }));
    try {
      expect(q<HTMLButtonElement>(mounted.container, '[data-input-allow]').disabled).toBe(true);
      expect(mounted.container.querySelector('[data-input-observing]')).not.toBeNull();

      await click(q(mounted.container, '[data-input-cancel]'));
      await settle();

      expect(calls.map(call => call.route)).toEqual([expect.stringContaining('/cancel')]);
      expect(mounted.container.textContent).toContain('Cancelled. Nothing was typed.');
    } finally {
      await mounted.unmount();
    }
  });
});
