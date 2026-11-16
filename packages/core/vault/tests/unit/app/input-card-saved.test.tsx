/**
 * The input card draws the daemon's saved-login offers: a tap delivers the account's HANDLE (`entry`, and the sign-in it
 * would use), never a value, and nothing on the card can echo what the daemon types. The card offers the slot after it
 * (`vault.input-settled`) only once a saved account settled it.
 */
import { describe, expect, it } from 'bun:test';
import { type PlacedPanel, RouterProvider, WithSlotPanels } from '@ferretry/app/testing';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import { savedChoices } from '../../../app/lib/input-card.ts';
import { INPUT_SETTLED_SLOT, InputDeliverBodySchema, InputRequestSchema } from '../../../contract/index.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { mount, must } from '../../support/app/dom.ts';
import {
  FAKE_VALUE,
  HAND_OFFER,
  MATCHED_OFFER,
  pasteRequest,
  REQUEST_ID,
  recordingClient,
  savedRequest,
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const DELIVERED = {
  id: REQUEST_ID,
  deliveryId: '123e4567-e89b-42d3-a456-426614174000',
  state: 'delivered',
  submitted: true,
};
const NOW = Date.parse('2026-11-10T00:00:00.000Z');

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const offer = (root: ParentNode, id: string) => q<HTMLButtonElement>(root, `[data-input-offer="${id}"]`);

async function card(request = savedRequest(), answer?: () => Promise<unknown>) {
  const rig = recordingClient(async route => {
    if (route.endsWith('/deliver')) return answer === undefined ? DELIVERED : await answer();
    return {};
  });
  const mounted = await mount(<InputCard client={rig.client} now={NOW} onDone={() => undefined} request={request} />);
  await settle();
  return { ...rig, mounted };
}

const deliverBody = (calls: readonly { route: string; init?: { body?: unknown } | undefined }[]) =>
  calls.find(call => call.route.endsWith('/deliver'))?.init?.body as Record<string, unknown> | undefined;

describe('the offers the daemon drew', () => {
  it('reads the fixture as the contract’s own request, so the card draws what the daemon sends', () => {
    expect(InputRequestSchema.safeParse(savedRequest()).success).toBe(true);
  });

  it('draws the matched account as the one-tap choice, with its words, and keeps the hand-picked one behind a second step', async () => {
    const { mounted } = await card();
    try {
      const primary = offer(mounted.container, MATCHED_OFFER.id);
      expect(primary.textContent).toContain('sudo on kirin-box');
      expect(primary.textContent).toContain('kirin');
      expect(primary.textContent).toContain('types its password');
      expect(primary.textContent).toContain('The only account that signs in here');
      expect(primary.hasAttribute('data-input-primary')).toBe(true);
      // The account picked by hand is not drawn yet; "Use another account…" opens it.
      expect(mounted.container.querySelector(`[data-input-offer="${HAND_OFFER.id}"]`)).toBeNull();
      const toggle = q<HTMLButtonElement>(mounted.container, '[data-input-other-toggle]');
      expect(toggle.textContent).toBe('Use another account…');
      await click(toggle);
      const hand = offer(mounted.container, HAND_OFFER.id);
      expect(hand.textContent).toContain('Work admin');
      expect(hand.textContent).toContain('Signs in at liftoff.okta.com');
      expect(hand.hasAttribute('data-input-primary')).toBe(false);
      // Typing it is still a way in.
      expect(mounted.container.querySelector('[data-input-value]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('draws no offer for a card the daemon offered none for, and none for a paste', async () => {
    const plain = await card(terminalRequest());
    try {
      expect(plain.mounted.container.querySelector('[data-input-saved]')).toBeNull();
    } finally {
      await plain.mounted.unmount();
    }
    const paste = await card(pasteRequest({ saved: savedRequest().saved }));
    try {
      expect(paste.mounted.container.querySelector('[data-input-saved]')).toBeNull();
      expect(savedChoices(pasteRequest({ saved: savedRequest().saved }))).toBeUndefined();
    } finally {
      await paste.mounted.unmount();
    }
  });

  it('says how a provider sign-in goes and when the page looks like a different account', async () => {
    const { mounted } = await card(
      savedRequest({
        saved: {
          match: 'accounts.google.com',
          offers: [MATCHED_OFFER],
          signIn: {
            id: 'GOOGLE_KIRIN',
            label: 'Google · kirin',
            method: { kind: 'google', via: 'GOOGLE_KIRIN' },
            via: { id: 'GOOGLE_KIRIN', label: 'Google · kirin' },
          },
          differentFrom: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
        },
      }),
    );
    try {
      expect(q(mounted.container, '[data-input-sign-in]').textContent).toBe('Sign in with Google via “Google · kirin”');
      expect(q(mounted.container, '[data-input-different]').textContent).toBe(
        'This looks like a different account from sudo on kirin-box.',
      );
    } finally {
      await mounted.unmount();
    }
  });
});

describe('a tap on a saved account', () => {
  it('delivers the account’s handle and sign-in as `entry`, with no typed value, and settles saying which account', async () => {
    const { mounted, calls } = await card();
    try {
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      const body = deliverBody(calls);
      expect(body).toMatchObject({
        entry: MATCHED_OFFER.id,
        signIn: MATCHED_OFFER.signIn,
        observedDigest: 'b'.repeat(64),
        submit: true,
      });
      // The daemon is the only one that opens the value: the body carries neither a padded value nor a field.
      expect(body).not.toHaveProperty('padded');
      expect(body).not.toHaveProperty('fields');
      expect(InputDeliverBodySchema.safeParse(body).success).toBe(true);
      expect(q(mounted.container, '[data-input-settled]').textContent).toBe(
        'Used sudo on kirin-box · kirin for %terminal:dev.',
      );
      expect(mounted.container.querySelector('[data-input-offer]')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('delivers an account picked by hand with its handle alone: it has no sign-in here', async () => {
    const { mounted, calls } = await card();
    try {
      await click(q(mounted.container, '[data-input-other-toggle]'));
      await click(offer(mounted.container, HAND_OFFER.id));
      await settle();
      const body = deliverBody(calls);
      expect(body).toMatchObject({ entry: HAND_OFFER.id });
      expect(body).not.toHaveProperty('signIn');
      expect(body).not.toHaveProperty('padded');
    } finally {
      await mounted.unmount();
    }
  });

  it('honours the Enter tick, and is still a send the daemon may refuse in words with the offers kept for another try', async () => {
    const { mounted, calls } = await card(
      savedRequest({ submit: 'offer-owner', target: { kind: 'page', key: 'app' } }),
      async () => {
        throw Object.assign(new Error('the daemon refused'), { status: 409, code: 'target_changed' });
      },
    );
    try {
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      expect(deliverBody(calls)).toMatchObject({ submit: false });
      expect(q(mounted.container, '[data-input-failure]').textContent).toContain('nothing was typed');
      // Still open: the owner may tap again.
      expect(offer(mounted.container, MATCHED_OFFER.id).disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('asks again with a new delivery id for another account, and the same one for the same account', async () => {
    let attempts = 0;
    const { mounted, calls } = await card(savedRequest(), async () => {
      attempts += 1;
      // Never answered in a way the card can read, so the id of the first try is kept for a repeat of it.
      throw new Error('network down');
    });
    try {
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      await click(q(mounted.container, '[data-input-other-toggle]'));
      await click(offer(mounted.container, HAND_OFFER.id));
      await settle();
      const ids = calls.filter(call => call.route.endsWith('/deliver')).map(call => deliverBody([call])?.deliveryId);
      expect(attempts).toBe(3);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    } finally {
      await mounted.unmount();
    }
  });

  it('still sends a typed value when offers are drawn, and nothing of a saved account with it', async () => {
    const { mounted, calls } = await card();
    try {
      await typeInto(q(mounted.container, '[data-input-value]'), FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      const body = deliverBody(calls);
      expect(body).toHaveProperty('padded');
      expect(body).not.toHaveProperty('entry');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the slot after a settled card', () => {
  const seen: Record<string, unknown>[] = [];
  const panel: PlacedPanel = {
    plugin: 'accounts',
    id: 'dont-ask-again',
    view: props => {
      seen.push(props);
      return <p data-after="">Don't ask again</p>;
    },
  };

  async function inShell(request = savedRequest()) {
    seen.length = 0;
    window.history.replaceState({}, '', '/d/dm1/agenda');
    const rig = recordingClient(async route => (route.endsWith('/deliver') ? DELIVERED : {}));
    const mounted = await mount(
      <RouterProvider screens={[{ plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' }]}>
        <WithSlotPanels slots={{ [INPUT_SETTLED_SLOT]: [panel] }}>
          <InputCard client={rig.client} now={NOW} onDone={() => undefined} request={request} />
        </WithSlotPanels>
      </RouterProvider>,
    );
    await settle();
    return mounted;
  }

  it('hands a contributed panel the ids the owner saw, once a saved account settled the card, and never a value', async () => {
    const mounted = await inShell();
    try {
      expect(mounted.container.querySelector('[data-after]')).toBeNull();
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      expect(q(mounted.container, '[data-after]').textContent).toBe("Don't ask again");
      expect(seen.at(-1)).toMatchObject({
        ferret: 'hadi',
        request: REQUEST_ID,
        entry: MATCHED_OFFER.id,
        signIn: MATCHED_OFFER.signIn,
        place: 'sudo@kirin-box',
        project: { id: 'p1', name: 'ferretry' },
        subject: 'hadi',
      });
      expect(JSON.stringify(seen)).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('offers nothing after a typed value', async () => {
    const mounted = await inShell();
    try {
      await typeInto(q(mounted.container, '[data-input-value]'), FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      expect(q(mounted.container, '[data-input-settled]').textContent).toBe('Sent to %terminal:dev.');
      expect(mounted.container.querySelector('[data-after]')).toBeNull();
      expect(seen).toHaveLength(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing after the card, and does not fail, where no shell places a panel', async () => {
    const { mounted } = await card();
    try {
      await click(offer(mounted.container, MATCHED_OFFER.id));
      await settle();
      expect(mounted.container.querySelector('[data-input-settled-slot]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
