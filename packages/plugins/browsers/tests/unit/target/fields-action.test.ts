import { afterEach, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { Document, Window } from 'happy-dom';
import { observeInputFields, typeInputFields } from '../../../daemon/target/lib/fields.ts';
import { boundedAction } from '../../../daemon/target/lib/form-action.ts';
import { FakeWorld } from '../../support/page-world.ts';

const DOCUMENT = 'https://document.example.test/login?doc=FAKE_QUERY#FAKE_FRAGMENT';
const BASE = 'https://base.example.test/forms/?base=FAKE_QUERY#FAKE_FRAGMENT';
const REQUESTED = 'https://requested.example.test/session';
const TARGETS = [{ id: '#code', target: { kind: 'selector' as const, selector: '#code' } }];
const opened: Window[] = [];

afterEach(async () => {
  for (const window of opened.splice(0)) await window.happyDOM.close();
});

/** Execute the actual isolated-world CDP field read over a synthetic DOM, with every network load disabled. */
function formWorld(action: string | null, formaction: string | null, external = false, buttonTag = 'button') {
  const window = new Window({
    url: DOCUMENT,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  opened.push(window);
  const doc = window.document;
  doc.head.innerHTML = `<base href="${BASE}">`;
  const form = doc.createElement('form');
  form.id = 'login';
  if (action !== null) form.setAttribute('action', action);
  const field = doc.createElement('input');
  field.id = 'code';
  field.type = 'password';
  form.append(field);
  const button = doc.createElement(buttonTag);
  button.setAttribute('type', 'submit');
  if (formaction !== null) button.setAttribute('formaction', formaction);
  if (external) {
    button.setAttribute('form', form.id);
    doc.body.append(button, form);
  } else {
    form.append(button);
    doc.body.append(form);
  }

  const world = new FakeWorld();
  world.element('#code', 31, ['type', 'password', 'id', 'code']);
  const session = world.session('page-target');
  const send = session.send.bind(session);
  // Happy DOM's Node.baseURI getter cannot receive a Document; its Document getter implements that case.
  const nodePrototype = Object.create(window.Node.prototype, {
    ...Object.getOwnPropertyDescriptors(window.Node.prototype),
    baseURI: { get: () => doc.baseURI },
  });
  session.send = async (method, params = {}) => {
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('aria-labelledby')) {
      const value = runInNewContext(`(${params.functionDeclaration}).call(field)`, {
        field,
        Node: { prototype: nodePrototype },
        Element: window.Element,
        Document,
        DocumentFragment: window.DocumentFragment,
        HTMLButtonElement: window.HTMLButtonElement,
        URL,
      });
      return { result: { value } };
    }
    return await send(method, params);
  };
  const observe = async () => {
    const result = await observeInputFields(world.subject, TARGETS);
    if (!result.ok) throw new Error('the synthetic field was not observed');
    return result.facts;
  };
  return { form, button, world, session, observe };
}

describe('HTML effective form action (R2-1)', () => {
  // Only the literal empty string uses the document URL; nonempty whitespace is parsed against the base URL.
  const cases = [
    ['empty submitter overrides form', REQUESTED, '', DOCUMENT],
    ['empty submitter overrides whitespace form', ' \t\n ', '', DOCUMENT],
    ['absent submitter falls back to form', REQUESTED, null, REQUESTED],
    ['empty form uses document URL', '', null, DOCUMENT],
    ['absent form uses document URL', null, null, DOCUMENT],
    ['both empty use document URL', '', '', DOCUMENT],
    ['whitespace submitter overrides form', REQUESTED, ' \t\n ', new URL(' \t\n ', BASE).href],
    ['whitespace form uses base URL', ' \t\n ', null, new URL(' \t\n ', BASE).href],
    ['non-ASCII space is a relative URL', REQUESTED, '\u00a0', new URL('\u00a0', BASE).href],
    ['relative submitter uses base URL', REQUESTED, 'send', new URL('send', BASE).href],
    ['relative form uses base URL', 'send', null, new URL('send', BASE).href],
    ['nonempty submitter overrides empty form', '', REQUESTED, REQUESTED],
  ] as const;

  for (const [name, action, formaction, effective] of cases) {
    it(name, async () => {
      const { observe } = formWorld(action, formaction);
      const facts = await observe();
      const proof = boundedAction(effective, 256);
      expect(facts.fields[0]?.unread).toBeUndefined();
      expect(facts.fields[0]?.field).toMatchObject({
        formAction: proof.display,
        formActionDigest: proof.digest,
        formActionOriginDigest: proof.originDigest,
      });
    });
  }

  for (const external of [false, true]) {
    for (const tag of ['button', 'input']) {
      it(`refuses a stale proof when ${external ? 'external' : 'internal'} ${tag} formaction becomes empty`, async () => {
        const { button, world, session, observe } = formWorld(REQUESTED, REQUESTED, external, tag);
        const facts = await observe();
        button.setAttribute('formaction', '');
        const result = await typeInputFields(world.subject, facts, [{ field: '#code', text: 'FAKE_CODE' }], false);
        expect(result).toBe('target_changed');
        expect(session.count('Input.insertText')).toBe(0);
        expect((await observe()).fields[0]?.field.formActionOriginDigest).not.toBe(
          facts.fields[0]?.field.formActionOriginDigest,
        );
      });
    }
  }

  for (const changed of ['', null, ' \t\n ']) {
    it(`refuses a stale proof when form action becomes ${JSON.stringify(changed)}`, async () => {
      const { form, world, session, observe } = formWorld(REQUESTED, null);
      const facts = await observe();
      if (changed === null) form.removeAttribute('action');
      else form.setAttribute('action', changed);
      expect(await typeInputFields(world.subject, facts, [{ field: '#code', text: 'FAKE_CODE' }], false)).toBe(
        'target_changed',
      );
      expect(session.count('Input.insertText')).toBe(0);
    });
  }

  it('fills an unchanged empty submitter destination and keeps its query and fragment off the wire', async () => {
    const { world, session, observe } = formWorld(REQUESTED, '');
    const facts = await observe();
    expect(facts.fields[0]?.field.formAction).toBe('https://document.example.test/login?[redacted]#[redacted]');
    expect(JSON.stringify(facts)).not.toContain('FAKE_QUERY');
    expect(JSON.stringify(facts)).not.toContain('FAKE_FRAGMENT');
    expect(await typeInputFields(world.subject, facts, [{ field: '#code', text: 'FAKE_CODE' }], false)).toBe('typed');
    expect(session.count('Input.insertText')).toBe(1);
  });

  const long = `https://requested.example.test/${'p'.repeat(300)}?query=FAKE_QUERY#FAKE_FRAGMENT`;
  for (const [name, changed] of [
    ['unchanged long destination fills', long],
    ['query-only destination change refuses', long.replace('FAKE_QUERY', 'OTHER_QUERY')],
    ['fragment-only destination change refuses', long.replace('FAKE_FRAGMENT', 'OTHER_FRAGMENT')],
  ] as const) {
    it(`keeps MUST 1: ${name}`, async () => {
      const { form, world, session, observe } = formWorld(long, null);
      const facts = await observe();
      form.setAttribute('action', changed);
      const unchanged = changed === long;
      expect(await typeInputFields(world.subject, facts, [{ field: '#code', text: 'FAKE_CODE' }], false)).toBe(
        unchanged ? 'typed' : 'target_changed',
      );
      expect(session.count('Input.insertText')).toBe(unchanged ? 1 : 0);
    });
  }
});
