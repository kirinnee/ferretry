import { describe, it } from 'bun:test';
import should from 'should';
import type { InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import { account, page, pageField, SESSION, site } from './grant-fixtures.ts';
import { world } from './world.ts';

/**
 * What the daemon makes of the agent's pick for a page field, from what the page says the field is: a one-time code is
 * a code (so no saved password is offered for it), a card field is a secret. The page and the accounts are fakes.
 */

const raise = (sensitivity: 'secret' | 'plain' | 'private' | 'code', label?: string): InputRaise => ({
  target: { kind: 'page', key: 'app' },
  prompt: 'GitHub asks for a value',
  fields: [
    {
      id: 'code',
      ...(label === undefined ? {} : { label }),
      sensitivity,
      element: { kind: 'selector', selector: '#field' },
    },
  ],
  submit: 'owner-default',
});

const facing = (attrs: NonNullable<Parameters<typeof pageField>[2]>): InputTargetFacts =>
  page({}, [pageField('code', {}, attrs)]);
const withPassword = (facts: InputTargetFacts) => ({
  facts,
  accounts: { accounts: [account()], signIns: [site()] },
});

const OTP = { name: 'otp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' };

describe('the card for a page field the page says is a one-time code', () => {
  for (const asked of ['secret', 'plain', 'private'] as const) {
    it(`should be a code card, with no saved password offered, when the agent asked for a ${asked}`, async () => {
      const w = world(withPassword(facing(OTP)));

      await w.service.raise(SESSION, raise(asked));
      const request = await w.pending();

      should(request.fields[0]?.sensitivity).equal('code');
      should(request.fields[0]?.label).equal('Code');
      should(request.saved?.offers.filter(offer => offer.fills === 'password')).eql([]);
    });
  }

  it('should keep a label the agent wrote', async () => {
    const w = world(withPassword(facing(OTP)));

    await w.service.raise(SESSION, raise('secret', 'Text message code'));

    const request = await w.pending();
    should(request.fields[0]).match({ label: 'Text message code', sensitivity: 'code' });
  });

  it('should offer a saved password for the same agent pick when the field is nothing like a code', async () => {
    const w = world(withPassword(facing({ name: 'field1', maxlength: '40' })));

    await w.service.raise(SESSION, raise('secret'));

    const request = await w.pending();
    should(request.fields[0]?.sensitivity).equal('secret');
    should(request.saved?.offers.some(offer => offer.fills === 'password')).be.true();
  });

  it('should stay a secret when the page says password too', async () => {
    const w = world(withPassword(facing({ ...OTP, name: 'otp_pin' })));

    await w.service.raise(SESSION, raise('secret'));

    should((await w.pending()).fields[0]?.sensitivity).equal('secret');
  });

  it('should stay a secret when the agent says password in its own label', async () => {
    const w = world(withPassword(facing(OTP)));

    await w.service.raise(SESSION, raise('secret', 'Account password'));

    should((await w.pending()).fields[0]?.sensitivity).equal('secret');
  });
});

describe('the card for a page field the page says is a card number, expiry or security code', () => {
  for (const attrs of [
    { name: 'cardnumber', autocomplete: 'cc-number', inputmode: 'numeric' },
    { name: 'exp-date', autocomplete: 'cc-exp' },
    { name: 'cvc', autocomplete: 'cc-csc', maxlength: '4' },
  ]) {
    it(`should be a secret when the agent asked for a plain value (${attrs.autocomplete})`, async () => {
      const w = world(withPassword(facing(attrs)));

      await w.service.raise(SESSION, raise('plain'));
      const request = await w.pending();

      should(request.fields[0]?.sensitivity).equal('secret');
    });
  }
});
