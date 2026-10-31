import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { unpadInputValue } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { fieldsOf, REOBSERVING, SAVE_TOO_SHORT } from '../../../src/lib/input-card.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { byText, click, settle, typeInto } from '../../support/dom-form.ts';
import { type Call, fakeClient, NOW, offer, request, saved, withSaved } from '../../support/input-fixtures.ts';

const SECRET = 'correct-horse-battery';
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const answerDelivered = (call: Call) => {
  const body = (call.body ?? {}) as { deliveryId?: string };
  return { id: 'ab'.repeat(16), deliveryId: body.deliveryId, state: 'delivered', submitted: true };
};

const show = async (
  value: InputRequest,
  answer: (call: Call) => unknown = answerDelivered,
  done: () => void = () => undefined,
) => {
  const fake = fakeClient(answer);
  const view = await mount(
    <InputCard
      agentName="Hadi"
      client={fake.client}
      now={NOW}
      onDone={done}
      request={value}
      fields={fieldsOf(value)}
    />,
  );
  mounted.push(view);
  const q = <T extends Element = HTMLElement>(selector: string): T | null => view.container.querySelector<T>(selector);
  return { ...fake, view, q };
};

const deliver = (calls: readonly Call[]): Call =>
  must(
    calls.find(call => call.path.endsWith('/deliver')),
    'a deliver call',
  );

describe('the card', () => {
  it('draws the daemon facts large and the agent words small, with the title, target and countdown', async () => {
    const { q } = await show(request());

    expect(q('[data-input-title]')?.textContent).toBe('!A7 · Hadi needs a password');
    expect(q('[data-input-target]')?.textContent).toBe('%terminal:deploy');
    expect(q('[data-input-expiry]')?.textContent).toBe('4m 00s left');
    expect(q('[data-input-program]')?.textContent).toBe('sudo');
    expect(q('[data-input-echo]')?.textContent).toContain('typing hidden');
    expect(q('[data-input-prompt-line]')?.textContent).toBe('[sudo] password for kirin:');
    expect(q('[data-input-agent-says]')?.textContent).toContain('Hadi says');
    expect(q('[data-input-risk]')?.getAttribute('data-input-risk')).toBe('green');
  });

  it('types into a masked field that autofill and spellcheck leave alone', async () => {
    const { q } = await show(request());
    const field = must(q<HTMLInputElement>('[data-input-value]'), 'the field');

    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  });

  it('asks a one-time code for the code keyboard and offers no Save', async () => {
    const { q } = await show(request({ sensitivity: 'private', saved: saved({ saves: undefined }) }));
    const field = must(q<HTMLInputElement>('[data-input-value]'), 'the field');

    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(q('[data-input-save]')).toBeNull();
  });

  it('says a plain answer is not secret', async () => {
    const { q } = await show(request({ sensitivity: 'plain' }));

    expect(must(q<HTMLInputElement>('[data-input-value]'), 'the field').type).toBe('text');
    expect(q('[data-input-plain]')?.textContent).toBe('Not secret: the ferret can see this value.');
  });

  it('reveals locally and does not remember it', async () => {
    const { q } = await show(request());
    const field = must(q<HTMLInputElement>('[data-input-value]'), 'the field');

    await click(q('[data-input-reveal]'));
    expect(field.type).toBe('text');
    await click(q('[data-input-reveal]'));
    expect(field.type).toBe('password');
  });

  it('hides Press Enter when the agent presses it, and ticks it for a terminal secret otherwise', async () => {
    const agent = await show(request({ submit: 'agent' }));
    expect(agent.q('[data-input-enter]')).toBeNull();

    const owner = await show(request());
    expect(must(owner.q<HTMLInputElement>('[data-input-enter]'), 'the tick').checked).toBe(true);
  });
});

describe('next time: a saved login', () => {
  const matched = offer({ username: 'kirin' });

  it('puts one tap first, and a tap sends the handle and no value', async () => {
    const { q, calls } = await show(withSaved(saved({ offers: [matched] })));

    expect(q('[data-input-value]')).toBeNull();
    expect(q('[data-input-offer-matched]')?.textContent).toContain('Use saved sudo on kirin-box');
    expect(q('[data-input-offer-matched]')?.textContent).toContain('kirin');

    await click(q('[data-input-offer-matched]'));
    await settle();

    const body = deliver(calls).body as Record<string, unknown>;
    expect(body.entry).toBe('SUDO_KIRIN_BOX');
    expect(body.padded).toBeUndefined();
    expect(body.save).toBeUndefined();
    expect(q('[data-input-settled]')?.textContent).toContain('Sent to %terminal:deploy');
  });

  it('never sends on its own', async () => {
    const { calls } = await show(withSaved(saved({ offers: [matched] })));
    await settle();
    expect(calls).toEqual([]);
  });

  it('keeps typing one tap away', async () => {
    const { q } = await show(withSaved(saved({ offers: [matched] })));

    await click(q('[data-input-type-instead]'));

    expect(q('[data-input-value]')).not.toBeNull();
    expect(q('[data-input-save]')).not.toBeNull();
  });

  it('never makes a hinted login the primary when the daemon did not match it', async () => {
    const hinted = offer({ id: 'HINTED', label: 'from the ferret', matched: false, hinted: true });
    const { q } = await show(withSaved(saved({ offers: [hinted] })));

    expect(q('[data-input-offer-matched]')).toBeNull();
    expect(q('[data-input-value]')).not.toBeNull();
    const others = must(q('[data-input-others]'), 'the choose-another list');
    expect(others.textContent).toContain('Choose another saved login');
    expect(others.querySelector('[data-input-hinted]')?.textContent).toBe('the ferret suggested this');
  });

  it('tags a hinted login that is also matched, and still sends it as an entry', async () => {
    const both = offer({ hinted: true });
    const { q } = await show(withSaved(saved({ offers: [both] })));

    expect(q('[data-input-offer-matched] [data-input-hinted]')).not.toBeNull();
  });

  it('lets an unmatched login be picked by hand, and sends its handle', async () => {
    const other = offer({ id: 'GITHUB_KIRINNEE', label: 'GitHub (kirinnee)', matched: false });
    const { q, calls } = await show(withSaved(saved({ offers: [matched, other] })));

    await click(q('[data-input-others] [data-input-offer="GITHUB_KIRINNEE"]'));
    await settle();

    expect((deliver(calls).body as Record<string, unknown>).entry).toBe('GITHUB_KIRINNEE');
  });
});

describe('first time: typing and saving', () => {
  const type = async (view: Awaited<ReturnType<typeof show>>, text = SECRET) =>
    typeInto(view.q('[data-input-value]'), text);

  it('pads the value, sends it, and clears the field', async () => {
    const view = await show(request());
    await type(view);

    await click(view.q('[data-input-send]'));
    await settle();

    const body = deliver(view.calls).body as { padded: string; submit: boolean; entry?: string };
    expect(unpadInputValue(body.padded)).toBe(SECRET);
    expect(body.padded).not.toContain('..'.repeat(1000));
    expect(body.submit).toBe(true);
    expect(body.entry).toBeUndefined();
    expect(view.view.container.textContent).not.toContain(SECRET);
    expect(view.q('[data-input-settled]')).not.toBeNull();
  });

  it('empties the field the moment it sends, even when the machine never answers', async () => {
    const view = await show(request(), () => {
      throw new TypeError('network down');
    });
    await type(view);

    await click(view.q('[data-input-send]'));
    await settle();

    expect(must(view.q<HTMLInputElement>('[data-input-value]'), 'the field').value).toBe('');
    expect(view.q('[data-input-failure]')?.textContent).toContain('will not type twice');
  });

  it('keeps the same delivery id when the owner sends again after an unanswered send', async () => {
    let answered = false;
    const view = await show(request(), call => {
      if (!answered) {
        answered = true;
        throw new TypeError('network down');
      }
      return answerDelivered(call);
    });

    await type(view);
    await click(view.q('[data-input-send]'));
    await settle();
    await type(view);
    await click(view.q('[data-input-send]'));
    await settle();

    const ids = view.calls
      .filter(call => call.path.endsWith('/deliver'))
      .map(call => (call.body as { deliveryId: string }).deliveryId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('sends on Enter inside the field', async () => {
    const view = await show(request());
    await type(view);

    await interact(() =>
      must(view.q('[data-input-value]'), 'the field').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    await settle();

    expect(deliver(view.calls)).toBeDefined();
  });

  it('disables Send until something is typed, but never because of a red risk', async () => {
    const red = request({ risk: { level: 'red', reason: 'This does not look like a password prompt.' } });
    const view = await show(red);
    expect(must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send').disabled).toBe(true);

    await type(view);

    expect(must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send').disabled).toBe(false);
    expect(view.q('[data-input-risk]')?.getAttribute('data-input-risk')).toBe('red');
  });

  it('shows Save as with the daemon suggestion, and sends save with a long enough password', async () => {
    const view = await show(withSaved(saved()));
    await type(view);

    await click(view.q('[data-input-save-tick]'));
    expect(must(view.q<HTMLInputElement>('[data-input-save-label]'), 'label').value).toBe('sudo on kirin-box');
    expect(must(view.q<HTMLInputElement>('[data-input-save-id]'), 'handle').value).toBe('SUDO_KIRIN_BOX');
    await typeInto(view.q('[data-input-save-id]'), 'sudo kirin box');
    await click(view.q('[data-input-send]'));
    await settle();

    expect((deliver(view.calls).body as { save?: unknown }).save).toEqual({
      entry: 'SUDO_KIRIN_BOX',
      label: 'sudo on kirin-box',
    });
  });

  it('can send a short secret but cannot save it, and says why', async () => {
    const view = await show(withSaved(saved()));
    await type(view, 'abc');

    const tick = must(view.q<HTMLInputElement>('[data-input-save-tick]'), 'the tick');
    expect(tick.disabled).toBe(true);
    expect(view.q('[data-input-save-reason]')?.textContent).toBe(SAVE_TOO_SHORT);
    await click(view.q('[data-input-send]'));
    await settle();

    const body = deliver(view.calls).body as { save?: unknown; padded: string };
    expect(unpadInputValue(body.padded)).toBe('abc');
    expect(body.save).toBeUndefined();
  });

  it('hides Save entirely when this kind of value is never saved', async () => {
    const view = await show(withSaved(saved({ saves: undefined })));
    await type(view);
    expect(view.q('[data-input-save]')).toBeNull();
    await click(view.q('[data-input-send]'));
    await settle();
    expect((deliver(view.calls).body as { save?: unknown }).save).toBeUndefined();
  });

  it('says it updates the login that already has the handle', async () => {
    const existing = offer({ matched: false });
    const view = await show(withSaved(saved({ offers: [existing] })));
    await type(view);

    await click(view.q('[data-input-save-tick]'));

    expect(view.q('[data-input-save-updates]')?.textContent).toBe('updates sudo on kirin-box');
  });

  it('says Saved as, or the problem, after the send', async () => {
    const ok = await show(withSaved(saved()), call => ({
      ...answerDelivered(call),
      saved: { entry: 'SUDO_KIRIN_BOX', ok: true },
    }));
    await type(ok);
    await click(ok.q('[data-input-save-tick]'));
    await click(ok.q('[data-input-send]'));
    await settle();
    expect(ok.q('[data-input-settled]')?.textContent).toContain('Saved as sudo on kirin-box.');

    const bad = await show(withSaved(saved()), call => ({
      ...answerDelivered(call),
      saved: { entry: 'SUDO_KIRIN_BOX', ok: false, problem: 'the vault is full' },
    }));
    await type(bad);
    await click(bad.q('[data-input-save-tick]'));
    await click(bad.q('[data-input-send]'));
    await settle();
    expect(bad.q('[data-input-settled]')?.textContent).toContain('the vault is full');
  });
});

describe('where the value may live', () => {
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  };
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('clears the field when the page goes to the background', async () => {
    const view = await show(request());
    const field = must(view.q<HTMLInputElement>('[data-input-value]'), 'the field');
    await typeInto(field, SECRET);
    expect(field.value).toBe(SECRET);

    setVisibility('hidden');
    await interact(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(must(view.q<HTMLInputElement>('[data-input-value]'), 'the field').value).toBe('');
  });

  it('clears the field when the card unmounts', async () => {
    const view = await show(request());
    const field = must(view.q<HTMLInputElement>('[data-input-value]'), 'the field');
    await typeInto(field, SECRET);

    await view.view.unmount();
    mounted.splice(mounted.indexOf(view.view), 1);

    expect(field.value).toBe('');
  });

  it('never writes the value to localStorage or sessionStorage, nor the URL', async () => {
    const local = spyOn(Storage.prototype, 'setItem');
    const view = await show(request());
    await typeInto(view.q('[data-input-value]'), SECRET);
    await click(view.q('[data-input-send]'));
    await settle();

    for (const [, value] of local.mock.calls) expect(String(value)).not.toContain(SECRET);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(SECRET);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(SECRET);
    expect(location.href).not.toContain(SECRET);
    local.mockRestore();
  });
});

describe('while Ferretry looks at the target again', () => {
  it('disables Use and Send and says so', async () => {
    const view = await show(
      withSaved(saved({ offers: [offer()] }), { observed: undefined, risk: undefined, observedDigest: undefined }),
    );

    expect(view.q('[data-input-facts]')?.textContent).toContain(REOBSERVING);
    expect(must(view.q<HTMLButtonElement>('[data-input-offer-matched]'), 'Use').disabled).toBe(true);
    await click(view.q('[data-input-type-instead]'));
    await typeInto(view.q('[data-input-value]'), SECRET);
    expect(must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send').disabled).toBe(true);
  });
});

describe('cancelling', () => {
  it('posts an empty body and settles the card', async () => {
    let finished = 0;
    const view = await show(
      request(),
      () => ({}),
      () => {
        finished += 1;
      },
    );

    await click(byText(view.view.container, 'button', 'Cancel request'));
    await settle();

    const call = must(
      view.calls.find(each => each.path.endsWith('/cancel')),
      'a cancel call',
    );
    expect(call.body).toEqual({});
    expect(view.q('[data-input-settled]')?.textContent).toContain('Cancelled');
    expect(finished).toBe(1);
  });
});
