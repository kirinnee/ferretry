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
  it('should read a one-time code only by autocomplete or a numeric keypad of 4 to 8 digits', () => {
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code' })).equal('code');
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '6' })).equal('code');
    should(pageFieldKind({ tag: 'input', inputmode: 'tel', maxlength: '4', name: 'verificationCode' })).equal('code');
  });

  it('should never read a name or a label as evidence of a one-time code', () => {
    should(pageFieldKind({ tag: 'input', name: 'otp_value' }, 'Verification code')).equal(undefined);
    should(pageFieldKind({ tag: 'input', id: 'verificationCode' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', type: 'text', name: 'code' }, '2FA code')).equal(undefined);
  });

  it('should not read a zip code, a long numeric box, a password signal or a password-typed input as a one-time code', () => {
    should(pageFieldKind({ tag: 'input', name: 'zipcode' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '16' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', type: 'password', name: 'otp' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '6', name: 'pin' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '6', id: 'user_password' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code current-password' })).equal(undefined);
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
  it('should not call an otp or token one-time code a password, but keep a password-typed one', () => {
    should(
      passwordTarget(
        page({ tag: 'input', type: 'text', name: 'verificationCode', autocomplete: 'one-time-code' }),
        'f',
      ),
    ).equal(false);
    should(passwordTarget(page({ tag: 'input', type: 'password', name: 'otp' }), 'f')).equal(true);
    should(passwordTarget(page({ tag: 'input', type: 'password', autocomplete: 'current-password' }), 'f')).equal(true);
  });

  it('should call a card field secret', () => {
    should(passwordTarget(page({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), 'f')).equal(true);
  });
});

describe('the cards the owner sees', () => {
  it('should keep a one-time-code field the ferret called a secret a secret', async () => {
    const { service } = inputRequestService({
      facts: page({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }),
    });
    const view = await service.raise(SESSION, raise('secret'));
    const [request] = await service.list(HOST, SESSION);
    should(view.id).be.ok();
    should(request?.fields[0]?.sensitivity).equal('secret');
  });

  it('should keep a password-typed field a secret whatever its name says', async () => {
    const { service } = inputRequestService({ facts: page({ tag: 'input', type: 'password', name: 'otp' }) });
    await service.raise(SESSION, raise('secret'));
    const [request] = await service.list(HOST, SESSION);
    should(request?.fields[0]?.sensitivity).equal('secret');
  });

  const sensitivityOf = async (field: Field, sensitivity: 'secret' | 'plain', label: string, prompt?: string) => {
    const { service } = inputRequestService({ facts: page(field) });
    const asked = raise(sensitivity, label);
    await service.raise(SESSION, prompt === undefined ? asked : { ...asked, prompt });
    const [request] = await service.list(HOST, SESSION);
    return request?.fields[0]?.sensitivity;
  };

  it('should keep a reusable password in a text box called "code" a secret, whatever the ferret labels it', async () => {
    should(await sensitivityOf({ tag: 'input', type: 'text', name: 'code' }, 'secret', 'One-time code')).equal(
      'secret',
    );
    should(await sensitivityOf({ tag: 'input', type: 'text', id: 'otp' }, 'secret', 'Verification code')).equal(
      'secret',
    );
  });

  it('should keep a numeric box that says pin or password a secret', async () => {
    should(
      await sensitivityOf({ tag: 'input', inputmode: 'numeric', maxlength: '6', name: 'pin' }, 'secret', 'Code'),
    ).equal('secret');
    should(
      await sensitivityOf({ tag: 'input', inputmode: 'numeric', maxlength: '6', id: 'password' }, 'secret', 'Code'),
    ).equal('secret');
  });

  it('should keep a requested secret secret over one-time-code, even when the prompt mentions the password', async () => {
    const otp: Field = { tag: 'input', type: 'text', autocomplete: 'one-time-code' };
    should(await sensitivityOf(otp, 'secret', 'Code', 'Enter your password and the code the bank texted')).equal(
      'secret',
    );
    const keypad: Field = { tag: 'input', inputmode: 'numeric', maxlength: '6' };
    // The ferret's own label saying password only ever raises: a keypad field labelled so stays a secret (fix round 2).
    should(await sensitivityOf(keypad, 'secret', 'Password code', 'Your one-time password')).equal('secret');
    should(await sensitivityOf(keypad, 'secret', 'Code', 'Your one-time password')).equal('secret');
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

describe('pageFieldKind: PIN-like fields stay secret (fix round 2, B1)', () => {
  for (const name of ['pincode', 'userPin', 'mpin', 'ssnLast4', 'securityCode', 'Security Code']) {
    it(`${name} on a numeric keypad with maxlength 4-8 is not a code`, () => {
      should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '4', name })).equal(undefined);
      should(pageFieldKind({ tag: 'input', inputmode: 'tel', maxlength: '6', id: name })).equal(undefined);
    });
  }
  it('one-time-code stays a code, but not on a password-typed or password-named field', () => {
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code' })).equal('code');
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code', name: 'password' })).equal(undefined);
    should(pageFieldKind({ tag: 'input', autocomplete: 'one-time-code', type: 'password' })).equal(undefined);
  });
});

describe('pageFieldKind: the ferret label may only raise (fix round 2, B1 addendum)', () => {
  it('a label that says pin, password, ssn or security code keeps a keypad field secret', () => {
    for (const label of ['Card PIN', 'Account password', 'SSN last 4', 'Security code'])
      should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '4' }, label)).equal(undefined);
    should(pageFieldKind({ tag: 'input', inputmode: 'numeric', maxlength: '6' }, 'Verification code')).equal('code');
  });
});

describe('password signals and a requested secret always win (fix round 3, B1)', () => {
  const otp = { tag: 'input', type: 'text', autocomplete: 'one-time-code' } as const;
  for (const name of ['pincode', 'userPin', 'securityCode', 'ssnLast4', 'userCvv'])
    it(`${name} with one-time-code is not a code, as a name or an id`, () => {
      should(pageFieldKind({ ...otp, name })).not.equal('code');
      should(pageFieldKind({ ...otp, id: name })).not.equal('code');
    });
  for (const label of ['Card PIN', 'Account password'])
    it(`the ferret label "${label}" with one-time-code is not a code`, () => {
      should(pageFieldKind(otp, label)).equal(undefined);
    });
  it('a field the ferret asked for as a secret stays a secret over one-time-code', async () => {
    const { service } = inputRequestService({ facts: page(otp) });
    await service.raise(SESSION, raise('secret', 'Code'));
    const [request] = await service.list(HOST, SESSION);
    should(request?.fields[0]?.sensitivity).equal('secret');
  });
  it('a ferret-raised code on a pincode or userPin keypad is raised to secret (lock)', async () => {
    for (const name of ['pincode', 'userPin']) {
      const { service } = inputRequestService({
        facts: page({ tag: 'input', inputmode: 'numeric', maxlength: '4', name }),
      });
      await service.raise(SESSION, raise('code', 'Code'));
      const [request] = await service.list(HOST, SESSION);
      should(request?.fields[0]?.sensitivity).equal('secret');
    }
  });
  it('passwordTarget reads pincode and userPin as passwords', () => {
    for (const name of ['pincode', 'userPin'])
      should(passwordTarget(page({ tag: 'input', inputmode: 'numeric', maxlength: '4', name }), 'f')).equal(true);
  });
});

describe('real one-time codes stay codes, and card words are substrings (fix round 3)', () => {
  const otp = { tag: 'input', type: 'text', autocomplete: 'one-time-code' } as const;
  for (const name of ['otp', 'code', 'verificationCode', 'smsCode', 'totp', 'token'])
    it(`${name} with one-time-code stays a code`, () => {
      should(pageFieldKind({ ...otp, name })).equal('code');
      should(passwordTarget(page({ ...otp, name }), 'f')).equal(false);
    });
  it('the label "One-time passcode" keeps a one-time-code field a code', () => {
    should(pageFieldKind(otp, 'One-time passcode')).equal('code');
  });
  it('a ferret-raised code labelled "One-time passcode" stays a code', async () => {
    const { service } = inputRequestService({ facts: page(otp) });
    await service.raise(SESSION, raise('code', 'One-time passcode'));
    const [request] = await service.list(HOST, SESSION);
    should(request?.fields[0]?.sensitivity).equal('code');
  });
  it('userCvv is a card field', () => {
    should(pageFieldKind({ tag: 'input', name: 'userCvv' })).equal('card');
  });
});
