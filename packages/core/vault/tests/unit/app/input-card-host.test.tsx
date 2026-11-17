/**
 * The host finds the request an `ask:input` ask is the card of, and refuses to draw a field it cannot read exactly.
 * A malformed or extra shape on the value path shows nothing to type into: it never falls through to a raw field.
 */
import { describe, expect, it } from 'bun:test';
import { InputCardHost, isAskRequest } from '../../../app/features/input/input-card-host.tsx';
import { settle } from '../../support/app/dom-form.ts';
import { mount } from '../../support/app/dom.ts';
import {
  FAKE_VALUE,
  pageRequest,
  REQUEST_ID,
  recordingClient,
  savedRequest,
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const ask = (
  ref: Record<string, unknown> = { kind: 'input', request: REQUEST_ID },
  prompt = '[sudo] password for kirin:',
) => ({
  ref,
  subject: 'Hadi needs a password',
  context: `This follows A1 in the same login.\nThe agent says: ${prompt}`,
  ferret: 'hadi',
  ferretName: 'Hadi',
});

async function host(requests: readonly unknown[], value: unknown = ask()) {
  const rig = recordingClient(async route =>
    route === 'GET /v1/ferrets/:ferretId/input-requests' ? { requests } : {},
  );
  const mounted = await mount(<InputCardHost client={rig.client} value={value} />);
  await settle();
  return { ...rig, mounted };
}

describe('the input card host', () => {
  it('reads the ferret’s open requests and draws the one whose id the ask carries', async () => {
    const other = terminalRequest({ id: 'd'.repeat(32), prompt: 'a different prompt', agendaItemId: 'A9' });
    const { mounted, calls } = await host([other, terminalRequest()]);
    try {
      expect(calls[0]).toEqual({
        route: 'GET /v1/ferrets/:ferretId/input-requests',
        init: { params: { ferretId: 'hadi' } },
      });
      expect(mounted.container.querySelector(`[data-input-request="${REQUEST_ID}"]`)).not.toBeNull();
      expect(mounted.container.querySelectorAll('[data-input-value]')).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws the saved-login offers of a listed request, read through the contract’s own request shape', async () => {
    const { mounted } = await host([savedRequest()]);
    try {
      expect(mounted.container.querySelector('[data-input-offer="SUDO_KIRIN_BOX"]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-input-other-toggle]')).not.toBeNull();
      // No value is anywhere on the card: an offer is a handle and a label.
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('says the app needs updating for a request whose saved offers it cannot read', async () => {
    const odd = savedRequest({
      saved: {
        offers: [{ id: 'SUDO_KIRIN_BOX', label: 'sudo', fills: 'password', matched: true, secret: FAKE_VALUE }],
      },
    });
    const { mounted } = await host([odd]);
    try {
      expect(mounted.container.textContent).toContain('needs a newer version of the app');
      expect(mounted.container.querySelector('[data-input-offer]')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('names a request by the id the ask carries, whatever the prompt says, and by nothing else', () => {
    const request = terminalRequest();
    expect(isAskRequest(request, { ref: { kind: 'input', request: REQUEST_ID } })).toBe(true);
    expect(isAskRequest(request, { ref: { kind: 'input', request: 'e'.repeat(32) } })).toBe(false);
    expect(isAskRequest(request, { ref: { kind: 'input' } })).toBe(false);
  });

  it('binds the request whose id it was given when two open requests share one prompt', async () => {
    const first = terminalRequest({ id: 'c'.repeat(32), agendaItemId: 'A8' });
    const second = terminalRequest({ id: 'd'.repeat(32), agendaItemId: 'A9' });
    const { mounted } = await host([first, second], ask({ kind: 'input', request: second.id }));
    try {
      expect(mounted.container.querySelector(`[data-input-request="${second.id}"]`)).not.toBeNull();
      expect(mounted.container.querySelector(`[data-input-request="${first.id}"]`)).toBeNull();
      expect(mounted.container.querySelectorAll('[data-input-value]')).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('says the request is gone for an id the ferret does not list, and binds no other with the same prompt', async () => {
    const { mounted } = await host([terminalRequest()], ask({ kind: 'input', request: 'e'.repeat(32) }));
    try {
      expect(mounted.container.textContent).toContain('This request is no longer open.');
      expect(mounted.container.querySelector('[data-input-request]')).toBeNull();
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('says the request is gone for an ask that carries no id, even when a prompt matches', async () => {
    const { mounted } = await host([terminalRequest()], ask({ kind: 'input' }));
    try {
      expect(mounted.container.textContent).toContain('This request is no longer open.');
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('says a request that is no longer listed is no longer open, and draws no field', async () => {
    const { mounted } = await host([]);
    try {
      expect(mounted.container.textContent).toContain('This request is no longer open.');
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('draws no field for a request with an extra shape on a field, and says the app needs updating', async () => {
    const odd = terminalRequest({
      fields: [{ id: 'value', label: 'Password', sensitivity: 'secret', default: FAKE_VALUE }],
    });
    const { mounted } = await host([odd]);
    try {
      expect(mounted.container.textContent).toContain('needs a newer version of the app');
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('reads a sensitivity it does not know as a secret, and draws no field for a target it does not know', async () => {
    // The contract's reader (a newer daemon's kind is the most careful one): a masked box, never a plain one.
    const odd = terminalRequest({ fields: [{ id: 'value', label: 'Password', sensitivity: 'telepathic' }] });
    const careful = await host([odd]);
    try {
      const box = careful.mounted.container.querySelector<HTMLInputElement>('[data-input-value]');
      expect(box?.type).toBe('password');
    } finally {
      await careful.mounted.unmount();
    }
    const elsewhere = pageRequest({ target: { kind: 'carrier-pigeon', key: 'coop' } });
    const { mounted } = await host([elsewhere]);
    try {
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('draws a paste of a secure copy with no field to type into', async () => {
    const paste = terminalRequest({
      source: { kind: 'sealed', name: 'some_copy', from: { kind: 'command', program: 'gh' } },
      target: { kind: 'secret', key: 'SOME_COPY' },
    });
    const { mounted } = await host([paste]);
    try {
      expect(mounted.container.querySelector('[data-input-paste]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing for a value that is not an ask, and reads nothing', async () => {
    const { mounted, calls } = await host([terminalRequest()], { not: 'an ask' });
    try {
      expect(mounted.container.querySelector('[data-input-request]')).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });
});
