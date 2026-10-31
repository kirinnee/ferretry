import { afterEach, describe, expect, it } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { fieldsOf, pastedWords, REOBSERVING, sealedBody } from '../../../src/lib/input-card.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient, NOW, request } from '../../support/input-fixtures.ts';

const PASTE = request({ source: { kind: 'sealed', name: 'vercel', from: { kind: 'command', program: 'gh' } } });
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const show = async (value: InputRequest, answer: (call: Call) => unknown) => {
  const fake = fakeClient(answer);
  let done = 0;
  const view = await mount(
    <InputCard
      agentName="Hadi"
      client={fake.client}
      fields={fieldsOf(value)}
      now={NOW}
      onDone={() => {
        done += 1;
      }}
      request={value}
    />,
  );
  mounted.push(view);
  const q = (selector: string): HTMLElement | null => view.container.querySelector<HTMLElement>(selector);
  return { ...fake, q, done: () => done };
};

const delivered = (call: Call) => ({
  id: 'ab'.repeat(16),
  deliveryId: (call.body as { deliveryId: string }).deliveryId,
  state: 'delivered',
  submitted: true,
});

describe('a paste card', () => {
  it('shows what it pastes and where it came from, with no field to type into', async () => {
    const { q } = await show(PASTE, delivered);

    expect(q('[data-input-paste]')?.textContent).toContain('sealed:vercel, captured from gh');
    expect(q('[data-input-value]')).toBeNull();
    expect(q('[data-input-send]')).toBeNull();
  });

  it('allows the paste with no value in the body, once', async () => {
    const { q, calls, done } = await show(PASTE, delivered);

    await click(q('[data-input-allow]'));
    await settle();

    const sent = calls.filter(call => call.path.endsWith('/deliver'));
    expect(sent).toHaveLength(1);
    const body = must(sent[0], 'the deliver').body as Record<string, unknown>;
    expect(body.sealed).toBe(true);
    expect(body.padded).toBeUndefined();
    expect(body.entry).toBeUndefined();
    expect(q('[data-input-settled]')?.textContent).toBe('Pasted into %terminal:deploy.');
    expect(done()).toBe(1);
  });

  it('keeps the delivery id after a paste nobody answered, and says why it failed', async () => {
    const ids: string[] = [];
    const { q } = await show(PASTE, call => {
      if (call.path.endsWith('/deliver')) {
        ids.push((call.body as { deliveryId: string }).deliveryId);
        throw new TypeError('network down');
      }
      return {};
    });

    await click(q('[data-input-allow]'));
    await settle();
    await click(q('[data-input-allow]'));
    await settle();

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1] as string);
    expect(q('[data-input-failure]')?.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('the paste body', () => {
  it('names no value and no copy: the daemon pastes the one the request names', () => {
    const built = sealedBody(PASTE, true, 'd'.repeat(8));

    expect(built).toEqual({
      ok: true,
      body: { deliveryId: 'dddddddd', observedDigest: 'a'.repeat(64), sealed: true, submit: true },
    });
    expect(sealedBody({ ...PASTE, observedDigest: undefined }, true, 'x')).toEqual({ ok: false, problem: REOBSERVING });
    expect(pastedWords(request())).toBeUndefined();
    expect(
      pastedWords(
        request({ source: { kind: 'sealed', name: 'gh', from: { kind: 'browser', origin: 'https://github.com' } } }),
      ),
    ).toBe('sealed:gh, captured from https://github.com');
  });

  it('keeps Allow off while the daemon is looking at the target again', async () => {
    const { q, calls } = await show({ ...PASTE, observedDigest: undefined }, delivered);

    await click(q('[data-input-allow]'));
    await settle();

    expect(q('[data-input-allow]')?.hasAttribute('disabled')).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/deliver'))).toHaveLength(0);
  });
});
