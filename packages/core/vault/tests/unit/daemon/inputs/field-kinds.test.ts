import { describe, it } from 'bun:test';
import should from 'should';
import type { PageFieldFacts } from '../../../../contract/index.ts';
import { pageFieldKind, passwordSignalled, pickedOnPage } from '../../../../daemon/lib/inputs/field-kinds.ts';

type Field = PageFieldFacts['field'];
const input = (over: Partial<Field> = {}): Field => ({ tag: 'input', type: 'text', ...over });

/**
 * Shapes modelled on the public sign-in and checkout markup of the sites named (attribute names as those sites are known
 * to write them; modelled from memory, not captured from a live page, so a site's markup may have moved on).
 */
const SHAPES: readonly {
  readonly site: string;
  readonly what: string;
  readonly field: Field;
  readonly kind: string;
}[] = [
  // GitHub
  {
    site: 'GitHub',
    what: 'login',
    field: input({ name: 'login', id: 'login_field', autocomplete: 'username' }),
    kind: 'none',
  },
  {
    site: 'GitHub',
    what: 'password',
    field: input({ type: 'password', name: 'password', id: 'password', autocomplete: 'current-password' }),
    kind: 'none',
  },
  {
    site: 'GitHub',
    what: 'authenticator app code',
    field: input({
      name: 'app_otp',
      id: 'app_totp',
      autocomplete: 'one-time-code',
      inputmode: 'numeric',
      maxlength: '6',
    }),
    kind: 'code',
  },
  {
    site: 'GitHub',
    what: 'sms code',
    field: input({
      name: 'sms_otp',
      id: 'sms_totp',
      autocomplete: 'one-time-code',
      inputmode: 'numeric',
      maxlength: '6',
    }),
    kind: 'code',
  },
  {
    site: 'GitHub',
    what: 'device verification code',
    field: input({ name: 'otp', id: 'otp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' }),
    kind: 'code',
  },
  // Google
  {
    site: 'Google',
    what: 'identifier',
    field: input({ type: 'email', name: 'identifier', id: 'identifierId', autocomplete: 'username' }),
    kind: 'none',
  },
  {
    site: 'Google',
    what: 'password',
    field: input({ type: 'password', name: 'Passwd', autocomplete: 'current-password' }),
    kind: 'none',
  },
  {
    site: 'Google',
    what: '2-step verification (totpPin, a code despite the word pin)',
    field: input({
      type: 'tel',
      name: 'totpPin',
      id: 'totpPin',
      autocomplete: 'off',
      inputmode: 'numeric',
      maxlength: '8',
    }),
    kind: 'code',
  },
  {
    site: 'Google',
    what: 'phone verification (a bare "pin": kept a secret, the agent’s pick stands)',
    field: input({ type: 'tel', name: 'pin', id: 'idvPin', inputmode: 'numeric', maxlength: '6' }),
    kind: 'none',
  },
  // Okta
  {
    site: 'Okta',
    what: 'username',
    field: input({ name: 'identifier', id: 'input28', autocomplete: 'username' }),
    kind: 'none',
  },
  {
    site: 'Okta',
    what: 'password',
    field: input({ type: 'password', name: 'credentials.passcode', id: 'input53', autocomplete: 'current-password' }),
    kind: 'none',
  },
  {
    site: 'Okta',
    what: 'verify code, labelled by the page',
    field: input({ name: 'verifyCode', id: 'input61', maxlength: '6', label: 'Enter code' }),
    kind: 'code',
  },
  {
    site: 'Okta',
    what: 'verify code, one-time-code autocomplete but a passcode name: the password word wins',
    field: input({ name: 'credentials.passcode', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' }),
    kind: 'none',
  },
  // Chase
  {
    site: 'Chase',
    what: 'user id',
    field: input({ name: 'userId', id: 'userId-input-field-input', autocomplete: 'username' }),
    kind: 'none',
  },
  {
    site: 'Chase',
    what: 'password',
    field: input({
      type: 'password',
      name: 'password',
      id: 'password-input-field-input',
      autocomplete: 'current-password',
    }),
    kind: 'none',
  },
  {
    site: 'Chase',
    what: 'one-time code box',
    field: input({ name: 'otpInput', id: 'otpInput-input', inputmode: 'numeric', maxlength: '8' }),
    kind: 'code',
  },
  {
    site: 'Chase',
    what: 'debit card PIN',
    field: input({ type: 'password', name: 'cardPin', id: 'pin-input', inputmode: 'numeric', maxlength: '4' }),
    kind: 'none',
  },
  // Stripe
  {
    site: 'Stripe',
    what: 'card number',
    field: input({ name: 'cardnumber', autocomplete: 'cc-number', inputmode: 'numeric' }),
    kind: 'card',
  },
  {
    site: 'Stripe',
    what: 'card expiry',
    field: input({ name: 'exp-date', autocomplete: 'cc-exp', inputmode: 'numeric' }),
    kind: 'card',
  },
  {
    site: 'Stripe',
    what: 'card security code',
    field: input({ name: 'cvc', autocomplete: 'cc-csc', inputmode: 'numeric', maxlength: '4' }),
    kind: 'card',
  },
  {
    site: 'Stripe',
    what: 'Link sign-in digit box (one digit each)',
    field: input({ autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '1' }),
    kind: 'code',
  },
  // Other shapes the rules must not misread
  {
    site: 'Any',
    what: 'zip code on a numeric keypad',
    field: input({ name: 'zip', autocomplete: 'postal-code', inputmode: 'numeric', maxlength: '5' }),
    kind: 'none',
  },
  {
    site: 'Any',
    what: 'promo code',
    field: input({ name: 'promo_code', id: 'promo' }),
    kind: 'none',
  },
  {
    site: 'Any',
    what: 'a code box a page labels, short',
    field: input({ name: 'field1', maxlength: '6', label: 'Verification code' }),
    kind: 'code',
  },
  {
    site: 'Any',
    what: 'a long free-text "code" box is not a one-time code',
    field: input({ name: 'code', maxlength: '40' }),
    kind: 'none',
  },
  {
    site: 'Any',
    what: 'a numeric box with no maxlength',
    field: input({ name: 'amount_due', inputmode: 'numeric' }),
    kind: 'none',
  },
  {
    site: 'Any',
    what: 'card number labelled only by the page',
    field: input({ name: 'f_7', label: 'Card number' }),
    kind: 'card',
  },
  {
    site: 'Any',
    what: 'a plain text box called "footprint" (otp inside a word)',
    field: input({ name: 'footprint', maxlength: '6' }),
    kind: 'none',
  },
  {
    site: 'Any',
    what: 'a keypad box whose autocomplete says another thing',
    field: input({ autocomplete: 'tel', inputmode: 'numeric', maxlength: '6' }),
    kind: 'none',
  },
];

describe('pageFieldKind: what a page says a field is', () => {
  for (const shape of SHAPES) {
    it(`should read ${shape.site} ${shape.what} as ${shape.kind}`, () => {
      should(pageFieldKind(shape.field) ?? 'none').equal(shape.kind);
    });
  }

  it('should let a password word in the ferret’s label raise a code field to no code at all', () => {
    const otp = input({ name: 'otp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' });
    should(pageFieldKind(otp)).equal('code');
    should(pageFieldKind(otp, 'Your PIN')).be.undefined();
    should(pageFieldKind(otp, 'Account password')).be.undefined();
  });

  it('should read a card word in the ferret’s label as a card', () => {
    should(pageFieldKind(input({ name: 'x' }), 'Card number')).equal('card');
  });

  it('should never read the ferret’s own word as evidence of a code', () => {
    should(pageFieldKind(input({ name: 'x', maxlength: '6' }), 'Verification code')).be.undefined();
  });
});

describe('passwordSignalled', () => {
  it('should signal a password in any of the page’s words and keep ordinary words out', () => {
    for (const name of ['password', 'Passwd', 'pwd', 'ssn', 'mpin', 'pin', 'cardPin', 'userPIN', 'atmpin', 'cvv'])
      should(passwordSignalled(input({ name }))).be.true();
    for (const name of ['shipping', 'typing', 'spinner', 'opinion', 'pinned', 'Pinterest', 'otpInput', 'code'])
      should(passwordSignalled(input({ name }))).be.false();
  });

  it('should not read a one-time phrase as a password', () => {
    should(passwordSignalled(input({ name: 'totpPin' }))).be.false();
    should(passwordSignalled(input({ label: 'One-time passcode' }))).be.false();
  });
});

describe('pickedOnPage: the daemon’s pick over the agent’s', () => {
  const LABELS = { secret: 'Password', private: 'Private value', code: 'Code', plain: 'Value' } as const;
  const facts = (field: Field) => ({ kind: 'page', fields: [{ fieldId: 'f', field }] as unknown as PageFieldFacts[] });
  const otp = input({ name: 'otp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' });

  it('should make an OTP field a code whatever the agent called it, with the daemon’s own label following', () => {
    for (const sensitivity of ['secret', 'private', 'plain', 'code'] as const) {
      const picked = pickedOnPage(facts(otp), { id: 'f', label: LABELS[sensitivity], sensitivity }, LABELS);
      should(picked).eql({ id: 'f', label: 'Code', sensitivity: 'code' });
    }
  });

  it('should keep a label the agent wrote', () => {
    const picked = pickedOnPage(facts(otp), { id: 'f', label: 'Text message code', sensitivity: 'secret' }, LABELS);
    should(picked).eql({ id: 'f', label: 'Text message code', sensitivity: 'code' });
  });

  it('should make a card field a secret', () => {
    const card = input({ name: 'cardnumber', autocomplete: 'cc-number' });
    should(pickedOnPage(facts(card), { id: 'f', label: 'Value', sensitivity: 'plain' }, LABELS)).eql({
      id: 'f',
      label: 'Password',
      sensitivity: 'secret',
    });
  });

  it('should never lower a field the agent called secret when the agent’s own label says password', () => {
    const picked = pickedOnPage(facts(otp), { id: 'f', label: 'Account password', sensitivity: 'secret' }, LABELS);
    should(picked.sensitivity).equal('secret');
  });

  it('should leave a terminal and an unknown field as the agent asked', () => {
    const field = { id: 'f', label: 'Password', sensitivity: 'secret' as const };
    should(pickedOnPage({ kind: 'terminal' }, field, LABELS)).equal(field);
    should(pickedOnPage(facts(otp), { ...field, id: 'other' }, LABELS).sensitivity).equal('secret');
  });
});
