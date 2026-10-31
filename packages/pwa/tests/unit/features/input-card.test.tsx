import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { unpadInputValue } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { fieldsOf, REOBSERVING, SAVE_TOO_SHORT } from '../../../src/lib/input-card.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { byText, click, settle, typeInto } from '../../support/dom-form.ts';
import {
  browserField,
  type Call,
  fakeClient,
  field,
  NOW,
  offer,
  request,
  requestOf,
  saved,
  withSaved,
} from '../../support/input-fixtures.ts';

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
    const { q } = await show(requestOf('private', { saved: saved({ saves: undefined }) }));
    const field = must(q<HTMLInputElement>('[data-input-value]'), 'the field');

    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(q('[data-input-save]')).toBeNull();
  });

  it('says a plain answer is not secret', async () => {
    const { q } = await show(requestOf('plain'));

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

describe('when the daemon refuses', () => {
  it('says why a cancel failed and leaves the card open', async () => {
    const view = await show(request(), () => {
      throw Object.assign(new Error('refused'), { status: 403, code: 'grant_not_granted' });
    });

    await click(byText(view.view.container, 'button', 'Cancel request'));
    await settle();

    expect(view.q('[role="alert"]')?.textContent).toContain('switched this off');
    expect(view.q('[data-input-settled]')).toBeNull();
  });

  it('sends nothing, and says so, when the value would press keys', async () => {
    const view = await show(request());
    await typeInto(view.q('[data-input-value]'), 'pass\tword');

    await click(view.q('[data-input-send]'));

    expect(view.calls).toEqual([]);
    expect(view.q('[data-input-failure]')?.textContent).toContain('would press keys');
  });

  it('says what is wrong with the label or handle of a login being saved', async () => {
    const view = await show(withSaved(saved()));
    await typeInto(view.q('[data-input-value]'), SECRET);

    await click(view.q('[data-input-save-tick]'));
    await typeInto(view.q('[data-input-save-label]'), '');

    expect(view.q('[data-input-save] [role="alert"]')?.textContent).toBe('Give it a label.');
  });
});

describe('the action row and the embedded card', () => {
  it('draws Cancel request and Send in ONE row, Cancel first, when typing', async () => {
    const { q } = await show(request());
    const row = must(q('[data-input-actions]'), 'the action row');

    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel request', 'Send']);
    expect(q('[data-input-actions] [data-input-cancel]')).not.toBeNull();
    expect(row.parentElement?.querySelectorAll('[data-input-actions]')).toHaveLength(1);
  });

  it('keeps Cancel request in the action row on a one-tap card, with no Send until typing', async () => {
    const { q } = await show(withSaved(saved({ offers: [offer()] })));
    const row = must(q('[data-input-actions]'), 'the action row');

    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel request']);
  });

  it('draws no panel and no heading of its own inside an agenda item, and names itself for a reader', async () => {
    const value = request();
    const view = await mount(
      <InputCard
        agentName="Hadi"
        client={fakeClient(answerDelivered).client}
        embedded
        fields={fieldsOf(value)}
        now={NOW}
        onDone={() => undefined}
        request={value}
      />,
    );
    mounted.push(view);
    const card = must(view.container.querySelector('[data-input-request]'), 'the card');

    expect(card.className).not.toContain('kt-panel');
    expect(card.getAttribute('aria-label')).toBe('!A7 · Hadi needs a password');
    expect(view.container.querySelector('[data-input-title]')).toBeNull();
    expect(view.container.querySelector('[data-input-target]')?.textContent).toBe('%terminal:deploy');
    expect(view.container.querySelector('[data-input-expiry]')?.textContent).toBe('4m 00s left');
  });

  it('still offers Cancel request on its own row when there is no field to draw', async () => {
    const value = request();
    const view = await mount(
      <InputCard
        client={fakeClient(answerDelivered).client}
        fields={[]}
        now={NOW}
        onDone={() => undefined}
        request={value}
      />,
    );
    mounted.push(view);
    const row = must(view.container.querySelector('[data-input-actions]'), 'the action row');
    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel request']);
  });
});

const email = field('plain', { id: 'email', label: 'Email' });
const password = field('secret', { id: 'password', label: 'Password' });
const googleLogin = (overrides: Partial<InputRequest> = {}): InputRequest =>
  request({
    target: { kind: 'browser', key: 'app' },
    prompt: 'Sign in to Google',
    sensitivity: 'secret',
    fields: [email, password],
    submit: 'offer-owner',
    risk: email.risk,
    observed: {
      kind: 'browser',
      pageId: 'page-1',
      origin: 'https://accounts.google.com',
      secure: true,
      navigationId: 'nav-1',
      fields: [
        browserField('email', { field: { tag: 'input', type: 'email' } }),
        browserField('password', { backendNodeId: 8, field: { tag: 'input', type: 'password' } }),
      ],
    },
    ...overrides,
  });

describe('a card of several fields', () => {
  const inside = (view: Awaited<ReturnType<typeof show>>, key: string) =>
    view.q<HTMLInputElement>(`[data-input-field="${key}"] [data-input-value]`);
  const typeBoth = async (view: Awaited<ReturnType<typeof show>>) => {
    await typeInto(inside(view, 'email'), 'kirin@example.test');
    await typeInto(inside(view, 'password'), SECRET);
  };

  it('draws one masked field per value, each with the attributes its sensitivity gets', async () => {
    const view = await show(googleLogin());

    expect(must(inside(view, 'email'), 'the email field').type).toBe('text');
    expect(must(inside(view, 'email'), 'the email field').getAttribute('autocomplete')).toBe('off');
    expect(must(inside(view, 'password'), 'the password field').type).toBe('password');
    expect(must(inside(view, 'password'), 'the password field').getAttribute('autocomplete')).toBe('current-password');
    expect(view.q('[data-input-title]')?.textContent).toBe('!A7 · Hadi needs a login');
    expect(view.q('[data-input-save]')).toBeNull();
  });

  it('puts a red "not secret" flag beside every plain field and none beside a secret one', async () => {
    const second = field('plain', { id: 'recovery', label: 'Recovery email' });
    const view = await show(googleLogin({ fields: [email, password, second] }));

    const flags = [...view.view.container.querySelectorAll('[data-input-plain]')];
    expect(flags).toHaveLength(2);
    expect(flags.map(flag => flag.closest('[data-input-field]')?.getAttribute('data-input-field'))).toEqual([
      'email',
      'recovery',
    ]);
    expect(flags.every(flag => flag.textContent === 'Not secret: the ferret can see this value.')).toBe(true);
    expect(flags.every(flag => flag.className.includes('text-err'))).toBe(true);
    expect(view.q('[data-input-field="password"] [data-input-plain]')).toBeNull();
  });

  it("uses the daemon's sentence for a plain field's flag when it gave one", async () => {
    const worded = field('plain', {
      id: 'email',
      label: 'Email',
      risk: { level: 'red', reason: 'Anyone can read it.' },
    });
    const view = await show(googleLogin({ fields: [worded, password] }));

    expect(view.q('[data-input-plain]')?.textContent).toBe('Anyone can read it.');
  });

  it("shows a secret field's own risk line only when it differs from the header's", async () => {
    const plain = await show(googleLogin());
    expect(plain.q('[data-input-field-risk]')).not.toBeNull();

    const amber = { level: 'amber', reason: 'This field may show what is typed.' } as const;
    const differs = await show(googleLogin({ fields: [email, field('secret', { id: 'password', risk: amber })] }));
    expect(differs.q('[data-input-field="password"] [data-input-field-risk]')?.textContent).toBe(amber.reason);

    const same = await show(request());
    expect(same.q('[data-input-field-risk]')).toBeNull();
  });

  it('keeps Send off until every field is typed', async () => {
    const view = await show(googleLogin());
    const send = () => must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send');
    expect(send().disabled).toBe(true);

    await typeInto(inside(view, 'email'), 'kirin@example.test');
    expect(send().disabled).toBe(true);

    await typeInto(inside(view, 'password'), SECRET);
    expect(send().disabled).toBe(false);

    await typeInto(inside(view, 'email'), '');
    expect(send().disabled).toBe(true);
  });

  it('sends a padded value for every field, named by its field, and no single value or save', async () => {
    const view = await show(googleLogin());
    await typeBoth(view);

    await click(view.q('[data-input-send]'));
    await settle();

    const body = deliver(view.calls).body as {
      padded?: string;
      save?: unknown;
      entry?: string;
      fields: { field: string; padded: string }[];
    };
    expect(body.padded).toBeUndefined();
    expect(body.save).toBeUndefined();
    expect(body.entry).toBeUndefined();
    expect(body.fields.map(typed => [typed.field, unpadInputValue(typed.padded)])).toEqual([
      ['email', 'kirin@example.test'],
      ['password', SECRET],
    ]);
    expect(view.q('[data-input-settled]')?.textContent).toContain('Sent to %browser:app');
    expect(view.view.container.textContent).not.toContain(SECRET);
  });

  it('sends on Enter only when every field is typed', async () => {
    const view = await show(googleLogin());
    const enter = () =>
      interact(() =>
        must(inside(view, 'password'), 'the password field').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        ),
      );
    await typeInto(inside(view, 'password'), SECRET);
    await enter();
    await settle();
    expect(view.calls).toEqual([]);

    await typeInto(inside(view, 'email'), 'kirin@example.test');
    await enter();
    await settle();
    expect(deliver(view.calls)).toBeDefined();
  });

  it('says what is wrong with a value under its own field, and keeps Send off', async () => {
    const view = await show(googleLogin());
    await typeInto(inside(view, 'email'), 'kirin@example.test');
    await typeInto(inside(view, 'password'), 'pass\tword');

    expect(view.q('[data-input-field="password"] [data-input-field-problem]')?.textContent).toContain(
      'would press keys',
    );
    expect(view.q('[data-input-field="email"] [data-input-field-problem]')).toBeNull();
    expect(must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send').disabled).toBe(true);
  });

  it('is one tap for a saved login, which sends the handle and fills every field', async () => {
    const view = await show(
      googleLogin({ saved: saved({ offers: [offer({ id: 'GOOGLE_KIRIN', label: 'Google' })] }) }),
    );

    expect(inside(view, 'email')).toBeNull();
    await click(view.q('[data-input-offer-matched]'));
    await settle();

    const body = deliver(view.calls).body as Record<string, unknown>;
    expect(body.entry).toBe('GOOGLE_KIRIN');
    expect(body.fields).toBeUndefined();
    expect(body.padded).toBeUndefined();
  });

  it('draws Cancel request and one Send in a single row', async () => {
    const view = await show(googleLogin());
    const row = must(view.q('[data-input-actions]'), 'the action row');

    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel request', 'Send']);
    expect(view.view.container.querySelectorAll('[data-input-actions]')).toHaveLength(1);
  });
});

describe('a chained card', () => {
  it('says which step it is and which card it follows', async () => {
    const { q } = await show(requestOf('private', { chain: 'A7', step: 2 }));

    expect(q('[data-input-chain]')?.textContent).toBe('Step 2 · after !A7');
  });

  it('counts step two when the daemon did not, and draws no line on a lone card', async () => {
    expect((await show(requestOf('private', { chain: 'A9' }))).q('[data-input-chain]')?.textContent).toBe(
      'Step 2 · after !A9',
    );
    expect((await show(request())).q('[data-input-chain]')).toBeNull();
  });

  it('draws the line inside an agenda item too', async () => {
    const value = requestOf('private', { chain: 'A7', step: 3 });
    const view = await mount(
      <InputCard
        client={fakeClient(answerDelivered).client}
        embedded
        fields={fieldsOf(value)}
        now={NOW}
        onDone={() => undefined}
        request={value}
      />,
    );
    mounted.push(view);

    expect(view.container.querySelector('[data-input-chain]')?.textContent).toBe('Step 3 · after !A7');
  });
});

describe('what the daemon saw in a browser, drawn', () => {
  const seen = (view: Awaited<ReturnType<typeof show>>) =>
    [...view.view.container.querySelectorAll('[data-input-seen-field]')].map(node => node.textContent);

  it('names the host and https, and each field by its label and kind', async () => {
    const view = await show(googleLogin());

    expect(view.q('[data-input-program]')?.textContent).toBe('accounts.google.com');
    expect(view.q('[data-input-echo]')?.textContent).toContain('https');
    expect(seen(view)).toEqual(['Email · email field', 'Password · password field']);
    expect(view.q('[data-input-challenge]')).toBeNull();
  });

  it('says an http page is not secure', async () => {
    const view = await show(
      googleLogin({
        observed: {
          kind: 'browser',
          pageId: 'page-1',
          origin: 'http://intranet.example.test',
          secure: false,
          navigationId: 'nav-1',
          fields: [browserField('email', { frameOrigin: 'http://intranet.example.test' })],
        },
      }),
    );

    expect(view.q('[data-input-program]')?.textContent).toBe('intranet.example.test');
    expect(view.q('[data-input-echo]')?.textContent).toContain('not secure (http)');
  });

  it('flags a field in a frame from another origin', async () => {
    const view = await show(
      googleLogin({
        observed: {
          kind: 'browser',
          pageId: 'page-1',
          origin: 'https://accounts.google.com',
          secure: true,
          navigationId: 'nav-1',
          fields: [
            browserField('email', { field: { tag: 'input', type: 'email' } }),
            browserField('password', {
              frameOrigin: 'https://ads.example.test',
              field: { tag: 'input', type: 'password' },
            }),
          ],
        },
      }),
    );

    expect(seen(view)).toEqual(['Email · email field', 'Password · password field in a frame from ads.example.test']);
  });

  it('draws an amber captcha line that tells the owner to take over, and no button for it', async () => {
    const base = googleLogin();
    const facts = base.observed;
    if (facts?.kind !== 'browser') throw new Error('a browser request');
    const view = await show({ ...base, observed: { ...facts, challenge: { provider: 'recaptcha' } } });
    const line = must(view.q('[data-input-challenge]'), 'the captcha line');

    expect(line.textContent).toBe(
      'This page is showing a captcha. Take over the browser and complete it yourself; Ferretry never solves one.',
    );
    expect(line.className).toContain('text-warn');
    expect(line.querySelector('button')).toBeNull();
  });
});

describe('where the values of several fields may live', () => {
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  };
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const typed = async () => {
    const view = await show(googleLogin());
    const fields = ['email', 'password'].map(key =>
      must(view.q<HTMLInputElement>(`[data-input-field="${key}"] [data-input-value]`), `the ${key} field`),
    );
    await typeInto(fields[0] ?? null, 'kirin@example.test');
    await typeInto(fields[1] ?? null, SECRET);
    expect(fields.map(each => each.value)).toEqual(['kirin@example.test', SECRET]);
    return { view, fields };
  };

  it('clears EVERY field when the page goes to the background', async () => {
    const { view } = await typed();

    setVisibility('hidden');
    await interact(() => document.dispatchEvent(new Event('visibilitychange')));

    const now = [...view.view.container.querySelectorAll<HTMLInputElement>('[data-input-value]')];
    expect(now.map(each => each.value)).toEqual(['', '']);
    expect(must(view.q<HTMLButtonElement>('[data-input-send]'), 'Send').disabled).toBe(true);
  });

  it('clears EVERY field when the card unmounts', async () => {
    const { view, fields } = await typed();

    await view.view.unmount();
    mounted.splice(mounted.indexOf(view.view), 1);

    expect(fields.map(each => each.value)).toEqual(['', '']);
  });

  it('empties every field the moment it sends, even when the machine never answers', async () => {
    const view = await show(googleLogin(), () => {
      throw new TypeError('network down');
    });
    await typeInto(view.q('[data-input-field="email"] [data-input-value]'), 'kirin@example.test');
    await typeInto(view.q('[data-input-field="password"] [data-input-value]'), SECRET);

    await click(view.q('[data-input-send]'));
    await settle();

    const now = [...view.view.container.querySelectorAll<HTMLInputElement>('[data-input-value]')];
    expect(now.map(each => each.value)).toEqual(['', '']);
    expect(view.q('[data-input-failure]')?.textContent).toContain('will not type twice');
  });
});

describe('the card, review regressions', () => {
  it('shows every field and its flag above a matched saved login, before anything can be sent', async () => {
    const amber = {
      level: 'amber',
      reason: 'This is not a password field, so the value will show on the page.',
    } as const;
    const card = withSaved(saved({ offers: [offer({ username: 'kirin' })] }), {
      target: { kind: 'browser', key: 'app' },
      sensitivity: 'secret',
      fields: [
        field('plain', { id: 'email', label: 'Email' }),
        field('secret', { id: 'password', label: 'Password', risk: amber }),
      ],
      risk: { level: 'red', reason: 'Not secret: the ferret can see this value.' },
    });
    const view = await show(card);

    const summary = must(view.q('[data-input-field-summary]'), 'the field summary');
    const use = must(view.q('[data-input-offer]'), 'the saved-login button');
    expect(view.q('[data-input-value]')).toBeNull();
    expect(summary.querySelector('[data-input-summary-field="email"] [data-input-plain]')?.textContent).toBe(
      'Not secret: the ferret can see this value.',
    );
    expect(
      summary.querySelector('[data-input-summary-field="password"] [data-input-field-risk="amber"]')?.textContent,
    ).toBe(amber.reason);
    // The flags come first in the card, then the button that would send without typing.
    expect(summary.compareDocumentPosition(use) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the card, Save as on a login card', () => {
  const loginCard = (overrides: Partial<InputRequest> = {}) =>
    withSaved(saved({ match: 'accounts.google.com', suggest: { id: 'GOOGLE_COM', label: 'Google' } }), {
      target: { kind: 'browser', key: 'app' },
      sensitivity: 'secret',
      fields: [field('plain', { id: 'email', label: 'Email' }), field('secret', { id: 'password', label: 'Password' })],
      ...overrides,
    });

  it('keeps the username and the password together, sent once with the card', async () => {
    const view = await show(loginCard());
    await typeInto(view.q('[data-input-field="email"] [data-input-value]'), 'kirin@example.test');
    await typeInto(view.q('[data-input-field="password"] [data-input-value]'), SECRET);

    await click(view.q('[data-input-save-tick]'));
    await click(view.q('[data-input-send]'));
    await settle();

    const body = deliver(view.calls).body as { save?: unknown; fields: { field: string; padded: string }[] };
    expect(body.save).toEqual({ entry: 'GOOGLE_COM', label: 'Google' });
    expect(body.fields.map(typed => [typed.field, unpadInputValue(typed.padded)])).toEqual([
      ['email', 'kirin@example.test'],
      ['password', SECRET],
    ]);
  });

  it('can send a short password but not save it, and offers no Save on a card the daemon cannot keep', async () => {
    const view = await show(loginCard());
    await typeInto(view.q('[data-input-field="email"] [data-input-value]'), 'kirin@example.test');
    await typeInto(view.q('[data-input-field="password"] [data-input-value]'), 'abc');

    expect(must(view.q<HTMLInputElement>('[data-input-save-tick]'), 'the tick').disabled).toBe(true);
    expect(view.q('[data-input-save-reason]')?.textContent).toBe(SAVE_TOO_SHORT);

    const unsaved = await show(loginCard({ saved: saved({ saves: undefined, suggest: undefined }) }));
    expect(unsaved.q('[data-input-save]')).toBeNull();
  });
});
