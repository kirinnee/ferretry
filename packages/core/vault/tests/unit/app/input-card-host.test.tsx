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
  terminalRequest,
} from '../../support/app/input-fixtures.ts';

const ask = (ref: Record<string, unknown> = { kind: 'input' }, prompt = '[sudo] password for kirin:') => ({
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
  it('reads the ferret’s open requests and draws the one whose prompt the ask quotes', async () => {
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

  it('names a request by the id when the ask carries one, whatever the prompt says', () => {
    const request = terminalRequest();
    expect(isAskRequest(request, { ref: { kind: 'input', request: REQUEST_ID }, context: 'no quote' })).toBe(true);
    expect(isAskRequest(request, { ref: { kind: 'input', request: 'e'.repeat(32) }, context: ask().context })).toBe(
      false,
    );
    expect(isAskRequest(request, { ref: { kind: 'input' }, context: 'The agent says: something else' })).toBe(false);
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

  it('draws no field for a sensitivity or target it does not know', async () => {
    const odd = terminalRequest({ fields: [{ id: 'value', label: 'Password', sensitivity: 'telepathic' }] });
    const elsewhere = pageRequest({ target: { kind: 'carrier-pigeon', key: 'coop' } });
    for (const request of [odd, elsewhere]) {
      const { mounted } = await host([request], ask({ kind: 'input' }, request.prompt));
      try {
        expect(mounted.container.querySelector('[data-input-value]')).toBeNull();
      } finally {
        await mounted.unmount();
      }
    }
  });

  it('draws a paste of a secure copy with no field to type into', async () => {
    const paste = terminalRequest({
      source: { kind: 'sealed', name: 'SOME_COPY' },
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
