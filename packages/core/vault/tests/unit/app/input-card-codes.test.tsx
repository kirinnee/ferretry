/**
 * The input card draws "Use code from Ferretry" for an account whose 2FA seed Ferretry holds, and offers the codes slot
 * Accounts fills with "Set up automatic codes". A tap hands the account's handle, its sign-in and the KEY's id: no value,
 * because the code is made inside the daemon. Fixtures are fake ids and labels only.
 */
import { describe, expect, it } from 'bun:test';
import { type PlacedPanel, RouterProvider, WithSlotPanels } from '@ferretry/app/testing';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import {
  asksCode,
  codeButtonWords,
  codeCheckedWords,
  LOGIN_ONE_FACTOR_WARNING,
  offersCodesSlot,
} from '../../../app/lib/input-card.ts';
import {
  INPUT_CARD_CODES_SLOT,
  InputDeliverBodySchema,
  InputRequestSchema,
  type InputRequest,
} from '../../../contract/index.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { mount, must } from '../../support/app/dom.ts';
import { REQUEST_ID, recordingClient, terminalRequest } from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const DELIVERED = {
  id: REQUEST_ID,
  deliveryId: '123e4567-e89b-42d3-a456-426614174000',
  state: 'delivered',
  submitted: true,
};

const KEY_WORKED = { factor: 'tf_0123456789ab', label: 'Authy', checked: 'worked' } as const;
const KEY_FAILED = { factor: 'tf_ba9876543210', label: 'Backup phone', checked: 'failed' } as const;
const KEY_NEW = { factor: 'tf_aaaaaaaaaaaa', label: 'Spare' } as const;

const CODE_OFFER = {
  id: 'GITHUB_DEMO',
  label: 'GitHub · demo',
  fills: 'totp',
  matched: true,
  signIn: 'si_0123456789abcdef',
  primary: true,
  why: 'only',
  codes: [KEY_WORKED, KEY_FAILED],
} as const;

const PLAIN_CODE_OFFER = {
  id: 'GITHUB_DEMO',
  label: 'GitHub · demo',
  fills: 'totp',
  matched: true,
  signIn: 'si_0123456789abcdef',
  primary: true,
  why: 'only',
} as const;

const OTHER_CODE_OFFER = {
  id: 'GITLAB_DEMO',
  label: 'GitLab · demo',
  fills: 'totp',
  matched: true,
  signIn: 'si_fedcba9876543210',
  codes: [KEY_NEW],
} as const;

/** A card that asks a one-time code and carries the daemon's saved offers. */
const codeCard = (
  offers: readonly unknown[] = [CODE_OFFER],
  patch: Partial<Record<string, unknown>> = {},
): InputRequest =>
  terminalRequest({
    prompt: 'Authentication code:',
    sensitivity: 'code',
    fields: [{ id: 'value', label: 'Code', sensitivity: 'code' }],
    saved: { match: 'github.com', offers, project: { id: 'p1', name: 'demo-project' } },
    ...patch,
  });

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];

async function card(request: InputRequest) {
  const rig = recordingClient(async route => (route.endsWith('/deliver') ? DELIVERED : {}));
  const mounted = await mount(<InputCard client={rig.client} now={NOW} onDone={() => undefined} request={request} />);
  await settle();
  return { ...rig, mounted };
}

const deliverBody = (calls: readonly { route: string; init?: { body?: unknown } | undefined }[]) =>
  calls.find(call => call.route.endsWith('/deliver'))?.init?.body as Record<string, unknown> | undefined;

describe('the fixtures are the contract’s own', () => {
  it('reads as requests the daemon could send', () => {
    expect(InputRequestSchema.safeParse(codeCard()).success).toBe(true);
    expect(InputRequestSchema.safeParse(codeCard([CODE_OFFER, OTHER_CODE_OFFER])).success).toBe(true);
  });
});

describe('the code buttons', () => {
  it('draws one button per key in the daemon’s order, with what the last code came to', async () => {
    const { mounted } = await card(codeCard());
    try {
      const buttons = all(mounted.container, '[data-input-code-key]');
      expect(buttons.map(button => button.getAttribute('data-input-code-key'))).toEqual([
        KEY_WORKED.factor,
        KEY_FAILED.factor,
      ]);
      expect(buttons[0]?.textContent).toContain('Use code from Ferretry · Authy');
      expect(buttons[0]?.textContent).toContain('worked last time');
      expect(buttons[1]?.textContent).toContain('Use code from Ferretry · Backup phone');
      expect(buttons[1]?.textContent).toContain('did not work last time');
      // The plain "use saved" button of that account is replaced, not drawn beside them.
      expect(mounted.container.querySelector('[data-input-offer]')).toBeNull();
      expect(q(mounted.container, '[data-input-offer-codes]').textContent).toContain('GitHub · demo');
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing of a code that was never tried', async () => {
    const { mounted } = await card(codeCard([OTHER_CODE_OFFER]));
    try {
      expect(q(mounted.container, '[data-input-code-key]').textContent).toBe('Use code from Ferretry · Spare');
      expect(codeCheckedWords(KEY_NEW)).toBeUndefined();
      expect(codeCheckedWords(KEY_WORKED)).toBe('worked last time');
      expect(codeCheckedWords(KEY_FAILED)).toBe('did not work last time');
      expect(codeButtonWords(KEY_NEW)).toBe('Use code from Ferretry · Spare');
    } finally {
      await mounted.unmount();
    }
  });

  it('delivers the account, its sign-in and the key — and nothing else', async () => {
    const { mounted, calls } = await card(codeCard());
    try {
      await click(q(mounted.container, `[data-input-code-key="${KEY_FAILED.factor}"]`));
      await settle();
      const body = deliverBody(calls);
      expect(body).toEqual({
        deliveryId: expect.any(String),
        observedDigest: 'b'.repeat(64),
        entry: CODE_OFFER.id,
        signIn: CODE_OFFER.signIn,
        factor: KEY_FAILED.factor,
        submit: false,
      });
      expect(body).not.toHaveProperty('padded');
      expect(body).not.toHaveProperty('fields');
      expect(InputDeliverBodySchema.safeParse(body).success).toBe(true);
      expect(q(mounted.container, '[data-input-settled]').textContent).toContain(
        'Used a code from Ferretry (Backup phone)',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('draws the one-factor line once, however many accounts make codes', async () => {
    const { mounted } = await card(codeCard([CODE_OFFER, OTHER_CODE_OFFER]));
    try {
      const lines = all(mounted.container, '[data-input-one-factor]');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.textContent).toBe(LOGIN_ONE_FACTOR_WARNING);
      expect(all(mounted.container, '[data-input-code-key]')).toHaveLength(3);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps "Use saved" for an offer without codes, and draws no one-factor line for it', async () => {
    const { mounted } = await card(codeCard([PLAIN_CODE_OFFER]));
    try {
      expect(mounted.container.querySelector('[data-input-code-key]')).toBeNull();
      expect(q(mounted.container, `[data-input-offer="${PLAIN_CODE_OFFER.id}"]`).textContent).toContain(
        'types a one-time code Ferretry makes',
      );
      expect(mounted.container.querySelector('[data-input-one-factor]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('chooses nothing on the second click of one gesture', async () => {
    const { mounted, calls } = await card(codeCard());
    try {
      const target = q(mounted.container, `[data-input-code-key="${KEY_WORKED.factor}"]`);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
      await settle();
      expect(deliverBody(calls)).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it('draws no code button on a card the daemon upgraded to a secret', async () => {
    const upgraded = codeCard([CODE_OFFER], {
      sensitivity: 'secret',
      fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
    });
    expect(asksCode(upgraded)).toBe(false);
    expect(offersCodesSlot(upgraded)).toBe(false);
    const { mounted } = await card(upgraded);
    try {
      expect(mounted.container.querySelector('[data-input-code-key]')).toBeNull();
      expect(mounted.container.querySelector('[data-input-one-factor]')).toBeNull();
      expect(mounted.container.querySelector('[data-input-codes-slot]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the codes slot', () => {
  const seen: Record<string, unknown>[] = [];
  const panel: PlacedPanel = {
    plugin: 'accounts',
    id: 'input-codes',
    view: props => {
      seen.push(props);
      return (
        <button data-fill="" onClick={() => (props.refresh as () => void)()} type="button">
          Set up automatic codes
        </button>
      );
    },
  };

  async function inShell(request: InputRequest, onRefresh?: () => void) {
    seen.length = 0;
    window.history.replaceState({}, '', '/d/dm1/agenda');
    const rig = recordingClient(async route => (route.endsWith('/deliver') ? DELIVERED : {}));
    const mounted = await mount(
      <RouterProvider screens={[{ plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' }]}>
        <WithSlotPanels slots={{ [INPUT_CARD_CODES_SLOT]: [panel] }}>
          <InputCard
            client={rig.client}
            now={NOW}
            onDone={() => undefined}
            {...(onRefresh === undefined ? {} : { onRefresh })}
            request={request}
          />
        </WithSlotPanels>
      </RouterProvider>,
    );
    await settle();
    return mounted;
  }

  it('mounts on a pending code card, with the ids the card holds and no field value', async () => {
    let refreshed = 0;
    const mounted = await inShell(codeCard(), () => (refreshed += 1));
    try {
      const filler = q<HTMLButtonElement>(mounted.container, '[data-fill]');
      expect(filler.textContent).toBe('Set up automatic codes');
      expect(seen.at(-1)).toMatchObject({
        requestId: REQUEST_ID,
        ferretId: 'hadi',
        subject: 'hadi',
        saved: { match: 'github.com', project: { id: 'p1', name: 'demo-project' } },
      });
      expect(Object.keys(seen.at(-1) ?? {}).sort()).toEqual([
        'ferretId',
        'hold',
        'refresh',
        'requestId',
        'saved',
        'subject',
      ]);
      // The slot sits outside the form: what a plugin draws there has buttons and fields of its own.
      expect(q(mounted.container, '[data-input-form]').contains(filler)).toBe(false);
      await click(filler);
      expect(refreshed).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('is not offered on a card that asks a password, one that is no longer pending, or one with no saved facts', async () => {
    const password = await inShell(terminalRequest({ saved: { match: 'sudo@kirin-box', offers: [] } }));
    try {
      expect(password.container.querySelector('[data-fill]')).toBeNull();
    } finally {
      await password.unmount();
    }
    const settled = await inShell(codeCard([CODE_OFFER], { state: 'delivered' }));
    try {
      expect(settled.container.querySelector('[data-fill]')).toBeNull();
    } finally {
      await settled.unmount();
    }
    const bare = await inShell(codeCard([CODE_OFFER], { saved: undefined }));
    try {
      expect(bare.container.querySelector('[data-fill]')).toBeNull();
    } finally {
      await bare.unmount();
    }
  });

  it('keeps the card’s view while a panel in the slot says it is still offering, and lets go when it is done', async () => {
    const holds: [boolean, string | undefined][] = [];
    const holder: PlacedPanel = {
      plugin: 'accounts',
      id: 'input-codes',
      view: props => (
        <button data-hold="" onClick={() => (props.hold as (holding: boolean) => void)(true)} type="button">
          Set up
        </button>
      ),
    };
    window.history.replaceState({}, '', '/d/dm1/agenda');
    const rig = recordingClient(async () => ({}));
    const mounted = await mount(
      <RouterProvider screens={[{ plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' }]}>
        <WithSlotPanels slots={{ [INPUT_CARD_CODES_SLOT]: [holder] }}>
          <InputCard
            client={rig.client}
            now={NOW}
            onDone={() => undefined}
            onHold={(holding, settled) => holds.push([holding, settled])}
            request={codeCard()}
          />
        </WithSlotPanels>
      </RouterProvider>,
    );
    await settle();
    try {
      expect(holds).toEqual([]);
      await click(q(mounted.container, '[data-hold]'));
      expect(holds).toEqual([[true, undefined]]);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing, and does not fail, where no shell places a panel', async () => {
    const { mounted } = await card(codeCard());
    try {
      expect(mounted.container.querySelector('[data-input-codes-slot]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
