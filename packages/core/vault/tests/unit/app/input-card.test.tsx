/**
 * The input card's value path (I6) and its Enter default (I51), driven through the real card over a recording client.
 * The only values here are the obvious fakes in `input-fixtures.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import { padInputValue } from '../../../app/lib/input-wire.ts';
import { click, press, settle, typeInto } from '../../support/app/dom-form.ts';
import { interact, mount, must } from '../../support/app/dom.ts';
import {
  FAKE_VALUE,
  pageRequest,
  REQUEST_ID,
  recordingClient,
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const DELIVERED = { id: REQUEST_ID, state: 'delivered', submitted: true };
const NOW = Date.parse('2026-11-10T00:00:00.000Z');

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const field = (root: ParentNode) => q<HTMLInputElement>(root, '[data-input-value]');
const enterTick = (root: ParentNode) => q<HTMLInputElement>(root, '[data-input-enter]');

/** Holds the daemon's answer to a deliver until the test lets it go. */
function held() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

async function card(request = terminalRequest(), answer?: () => Promise<unknown>) {
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

/** Sends the page to the background, the way a browser tab switch does. */
async function hidePage(): Promise<() => void> {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await interact(() => document.dispatchEvent(new Event('visibilitychange')));
  return () => {
    if (original === undefined) Reflect.deleteProperty(document, 'visibilityState');
    else Object.defineProperty(document, 'visibilityState', original);
  };
}

describe('the input card holds a typed value only in its field', () => {
  it('I6 clears the field the moment Send is pressed, before the daemon answers, and keeps nothing after', async () => {
    const hold = held();
    const { mounted, calls } = await card(terminalRequest(), async () => {
      await hold.gate;
      return DELIVERED;
    });
    try {
      const input = field(mounted.container);
      await typeInto(input, FAKE_VALUE);
      expect(input.value).toBe(FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      // The deliver is on its way and unanswered: the value is in the body only, not in the field.
      expect(calls).toHaveLength(1);
      expect(input.value).toBe('');
      expect(calls[0]?.init?.body).toMatchObject({ padded: padInputValue(FAKE_VALUE) });
      hold.release();
      await settle();
      // Answered: no field is left and no part of the card carries the value.
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
      expect(mounted.container.textContent).toContain('Sent to %terminal:dev.');
    } finally {
      await mounted.unmount();
    }
  });

  it('I6 clears the field when a refused send leaves the card open, so a retry asks for the value again', async () => {
    const { mounted } = await card(terminalRequest(), async () => {
      throw Object.assign(new Error('the daemon refused'), { status: 409, code: 'target_changed' });
    });
    try {
      const input = field(mounted.container);
      await typeInto(input, FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      expect(field(mounted.container).value).toBe('');
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
      expect(q(mounted.container, '[data-input-failure]').textContent).toContain('nothing was typed');
    } finally {
      await mounted.unmount();
    }
  });

  it('I6 clears the field when the card unmounts', async () => {
    const { mounted } = await card();
    const input = field(mounted.container);
    await typeInto(input, FAKE_VALUE);
    expect(input.value).toBe(FAKE_VALUE);
    await mounted.unmount();
    // The node outlives the card in this test only because the test holds it; it holds nothing.
    expect(input.value).toBe('');
  });

  it('I6 clears the field when the page is hidden', async () => {
    const { mounted } = await card();
    try {
      const input = field(mounted.container);
      await typeInto(input, FAKE_VALUE);
      expect(input.value).toBe(FAKE_VALUE);
      const restore = await hidePage();
      try {
        expect(input.value).toBe('');
        expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
      } finally {
        restore();
      }
    } finally {
      await mounted.unmount();
    }
  });

  it('I6 clears every field of a card of several, on send and when the page is hidden', async () => {
    const request = terminalRequest({
      fields: [
        { id: 'user', label: 'Username', sensitivity: 'plain' },
        { id: 'pass', label: 'Password', sensitivity: 'secret' },
      ],
    });
    const { mounted, calls } = await card(request);
    try {
      const [user, pass] = [...mounted.container.querySelectorAll<HTMLInputElement>('[data-input-value]')];
      await typeInto(user ?? null, 'fake-user');
      await typeInto(pass ?? null, FAKE_VALUE);
      const restore = await hidePage();
      try {
        expect(user?.value).toBe('');
        expect(pass?.value).toBe('');
      } finally {
        restore();
      }
      await typeInto(user ?? null, 'fake-user');
      await typeInto(pass ?? null, FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      expect(calls[0]?.init?.body).toMatchObject({
        fields: [
          { field: 'user', padded: padInputValue('fake-user') },
          { field: 'pass', padded: padInputValue(FAKE_VALUE) },
        ],
      });
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('I6 sends the value padded to a bucket, never plain, and never in the route or its parameters', async () => {
    const { mounted, calls } = await card();
    try {
      await typeInto(field(mounted.container), FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      const call = must(calls[0], 'a deliver');
      expect(call.route).toBe('POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver');
      expect(call.init?.params).toEqual({ ferretId: 'hadi', requestId: REQUEST_ID });
      const padded = (must(call.init, 'an init').body as { padded: string }).padded;
      expect(padded).not.toBe(FAKE_VALUE);
      expect(padded.length % 256).toBe(0);
      expect(call.route + JSON.stringify(call.init?.params)).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the input card’s Enter default', () => {
  it('I51 starts ticked for a terminal secret and sends Enter with the value', async () => {
    const { mounted, calls } = await card(terminalRequest());
    try {
      expect(enterTick(mounted.container).checked).toBe(true);
      await typeInto(field(mounted.container), FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      expect(calls[0]?.init?.body).toMatchObject({ submit: true });
    } finally {
      await mounted.unmount();
    }
  });

  it('I51 starts un-ticked for a browser page and sends no Enter unless the owner ticks it', async () => {
    const off = await card(pageRequest());
    try {
      expect(enterTick(off.mounted.container).checked).toBe(false);
      await typeInto(field(off.mounted.container), FAKE_VALUE);
      await click(q(off.mounted.container, '[data-input-send]'));
      await settle();
      expect(off.calls[0]?.init?.body).toMatchObject({ submit: false });
    } finally {
      await off.mounted.unmount();
    }
    const on = await card(pageRequest());
    try {
      await click(enterTick(on.mounted.container));
      expect(enterTick(on.mounted.container).checked).toBe(true);
      await typeInto(field(on.mounted.container), FAKE_VALUE);
      await click(q(on.mounted.container, '[data-input-send]'));
      await settle();
      expect(on.calls[0]?.init?.body).toMatchObject({ submit: true });
    } finally {
      await on.mounted.unmount();
    }
  });

  it('I51 starts un-ticked for a terminal value that is not a secret, and ticked for an owner default', async () => {
    const code = await card(
      terminalRequest({ sensitivity: 'code', fields: [{ id: 'value', label: 'Code', sensitivity: 'code' }] }),
    );
    const owner = await card(pageRequest({ submit: 'owner-default' }));
    try {
      expect(enterTick(code.mounted.container).checked).toBe(false);
      expect(enterTick(owner.mounted.container).checked).toBe(true);
    } finally {
      await code.mounted.unmount();
      await owner.mounted.unmount();
    }
  });

  it('I51 offers no Enter tick when the agent presses Enter itself, and never sends one', async () => {
    const { mounted, calls } = await card(terminalRequest({ submit: 'agent' }));
    try {
      expect(mounted.container.querySelector('[data-input-enter]')).toBeNull();
      await typeInto(field(mounted.container), FAKE_VALUE);
      await click(q(mounted.container, '[data-input-send]'));
      await settle();
      expect(calls[0]?.init?.body).toMatchObject({ submit: false });
    } finally {
      await mounted.unmount();
    }
  });

  it('I6 sends on the Enter key inside the field only when a value is typed', async () => {
    const { mounted, calls } = await card();
    try {
      await press(field(mounted.container), 'Enter');
      expect(calls).toEqual([]);
      await typeInto(field(mounted.container), FAKE_VALUE);
      await press(field(mounted.container), 'Enter');
      await settle();
      expect(calls).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });
});
