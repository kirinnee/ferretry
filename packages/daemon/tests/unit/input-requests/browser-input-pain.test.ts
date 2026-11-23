import { describe, it } from 'bun:test';
import { type InputRaise, type InputTargetFacts, padInputValue } from '@ferretry/protocol';
import should from 'should';
import { pageFieldKind } from '../../../src/lib/input-requests/field-kinds.ts';
import { passwordTarget } from '../../../src/lib/input-requests/lock.ts';
import type { InputCaller } from '../../../src/lib/input-requests/ports.ts';
import { inputRequestService, SESSION } from './support.ts';

/** The owner's browser sign-in pains (!A607): no lock after typing, one-time codes are codes, a re-render never costs a second answer. */

const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
type PageFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;
type Field = PageFacts['fields'][number]['field'];

const page = (field: Field, backendNodeId = 1, id = 'f'): PageFacts => ({
  kind: 'browser',
  pageId: 'p1',
  origin: 'https://bank.example',
  secure: true,
  navigationId: 'nav-1',
  fields: [
    {
      fieldId: id,
      frameOrigin: 'https://bank.example',
      frameId: 'main',
      backendNodeId,
      field,
      box: { x: 1, y: 1, w: 100, h: 30 },
      visible: true,
    },
  ],
});

const raise = (sensitivity: 'secret' | 'code' | 'plain', label = 'Code'): InputRaise => ({
  target: { kind: 'browser', key: 'app' },
  prompt: 'The bank wants the verification code',
  fields: [{ id: 'f', sensitivity, label, element: { kind: 'ref', ref: 'e3' } }],
  submit: 'owner-default',
});

describe('pageFieldKind', () => {
  it('should read a one-time code by autocomplete, a numeric keypad of 4 to 8 digits, or its words', () => {
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code' })).equal('code');
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '6' })).equal('code');
    should(pageFieldKind({ tag: 'input', name: 'otp_value' })).equal('code');
    should(pageFieldKind({ tag: 'input', id: 'verificationCode' })).equal('code');
    should(pageFieldKind({ tag: 'input', name: 'twofa' }, '2FA code')).equal('code');
  });

  it('should not read a zip code, a long numeric box or a password-typed input as a one-time code', () => {
    should(pageFieldKind({ tag: 'input', name: 'zipcode' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '16' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', type: 'password', name: 'otp' })).equal(undefined);
  });

  it('should read a card number, expiry and security code as card fields', () => {
    should(pageFieldKind({ tag: 'input', autocomplete: 'cc-number' })).equal('card');
    should(pageFieldKind({ tag: 'input', autocomplete: 'cc-exp' })).equal('card');
    should(pageFieldKind({ tag: 'input', autocomplete: 'cc-csc' })).equal('card');
    should(pageFieldKind({ tag: 'input', name: 'cvv' })).equal('card');
    should(pageFieldKind({ tag: 'input', id: 'card-number' })).equal('card');
  });
});

describe('passwordTarget on a page', () => {
  it('should not call a "passcode" or "pin" one-time code a password, but keep a password-typed one', () => {
    should(
      passwordTarget(page({ tag: 'input', type: 'text', name: 'passcode', autocomplete: 'one-time-code' }), 'f'),
    ).equal(false);
    should(passwordTarget(page({ tag: 'input', type: 'password', name: 'otp' }), 'f')).equal(true);
    should(passwordTarget(page({ tag: 'input', type: 'password', autocomplete: 'current-password' }), 'f')).equal(true);
  });

  it('should call a card field secret', () => {
    should(passwordTarget(page({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), 'f')).equal(true);
  });
});

describe('the cards the owner sees', () => {
  it('should offer a one-time code field the ferret called a secret as a code', async () => {
    const { service } = inputRequestService({
      facts: page({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }),
    });
    const view = await service.raise(SESSION, raise('secret'));
    const [request] = await service.list(HOST, SESSION);
    should(view.id).be.ok();
    should(request?.fields[0]?.sensitivity).equal('code');
  });

  it('should keep a password-typed field a secret whatever its name says', async () => {
    const { service } = inputRequestService({ facts: page({ tag: 'input', type: 'password', name: 'otp' }) });
    await service.raise(SESSION, raise('secret'));
    const [request] = await service.list(HOST, SESSION);
    should(request?.fields[0]?.sensitivity).equal('secret');
  });

  it('should make a card number field a secret even when the ferret said plain', async () => {
    const { service } = inputRequestService({ facts: page({ tag: 'input', type: 'text', autocomplete: 'cc-number' }) });
    await service.raise(SESSION, raise('plain', 'Card number'));
    const [request] = await service.list(HOST, SESSION);
    should(request?.fields[0]?.sensitivity).equal('secret');
  });
});

describe('after the owner answers', () => {
  const answer = async (current: () => PageFacts) => {
    const w = inputRequestService({ facts: current });
    await w.service.raise(SESSION, raise('secret', 'Password'));
    const [request] = await w.service.list(HOST, SESSION);
    return { ...w, request: request as NonNullable<typeof request> };
  };
  const body = (digest: string, text: string) => ({
    deliveryId: 'd1',
    padded: padInputValue(text),
    submit: true,
    observedDigest: digest,
  });

  it('should leave the page readable at once: no lock on the card, no hold on the page', async () => {
    const field: Field = { tag: 'input', type: 'password', name: 'pw' };
    const { service, quarantine, request } = await answer(() => page(field));
    should(request.lock).equal(undefined);
    await service.deliver(SESSION, request.id, body(request.observedDigest as string, 'hunter2'), HOST);
    should(quarantine.until(SESSION, ['app', 'p1'])).equal(undefined);
  });

  it('should type into the new element when the page re-rendered the field, without asking the owner again', async () => {
    const field: Field = { tag: 'input', type: 'password', name: 'pw' };
    let node = 1;
    const { service, writes, request } = await answer(() => page(field, node));
    node = 2; // the page re-rendered: a new node with the same identity
    const result = await service.deliver(SESSION, request.id, body(request.observedDigest as string, 'hunter2'), HOST);
    should(result.state).equal('delivered');
    should(writes).eql(['hunter2']);
  });

  it('should still refuse a field that changed identity (a password field that became plain text)', async () => {
    let field: Field = { tag: 'input', type: 'password', name: 'pw' };
    const { service, writes, request } = await answer(() => page(field));
    field = { tag: 'input', type: 'text', name: 'pw' };
    await service.deliver(SESSION, request.id, body(request.observedDigest as string, 'hunter2'), HOST).then(
      () => should.fail(undefined, undefined, 'it must refuse'),
      () => undefined,
    );
    should(writes).eql([]);
  });

  it('should wake a waiting ferret in the same turn the value is typed', async () => {
    const field: Field = { tag: 'input', type: 'password', name: 'pw' };
    const { service, request } = await answer(() => page(field));
    const waiting = service.agentView(SESSION, request.agendaItemId, 60_000);
    const before = performance.now();
    await service.deliver(SESSION, request.id, body(request.observedDigest as string, 'hunter2'), HOST);
    const view = await waiting;
    should(view.state).equal('delivered');
    should(performance.now() - before).be.below(250);
  });
});
