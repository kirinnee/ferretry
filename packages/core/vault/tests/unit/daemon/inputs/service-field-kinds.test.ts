import { describe, it } from 'bun:test';
import should from 'should';
import type { InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import { account, page, pageField, SESSION, site } from './grant-fixtures.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { OWNER, world } from './world.ts';

/**
 * What the daemon makes of the agent's pick for a page field, from what the page says the field is: it may only RAISE it.
 * A plain one-time-code field is a code; a card field is a secret; an explicit secret or private ask is never lowered
 * (it stays masked), and a saved login password is never offered or typed into a code or card field. The page and the
 * accounts are fakes.
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
  it('should be a code card, with no saved password offered, when the agent asked for a plain value', async () => {
    const w = world(withPassword(facing(OTP)));

    await w.service.raise(SESSION, raise('plain'));
    const request = await w.pending();

    should(request.fields[0]?.sensitivity).equal('code');
    should(request.fields[0]?.label).equal('Code');
    should(request.saved?.offers.filter(offer => offer.fills === 'password')).eql([]);
  });

  const LOOKS_LIKE_A_CODE: readonly [string, NonNullable<Parameters<typeof pageField>[2]>][] = [
    ['one-time-code, numeric, maxlength 6', OTP],
    ['a numeric keypad of maxlength 6 and nothing else', { inputmode: 'numeric', maxlength: '6' }],
    ['a field named accessCode', { name: 'accessCode', maxlength: '6' }],
  ];
  for (const asked of ['secret', 'private'] as const)
    for (const [what, attrs] of LOOKS_LIKE_A_CODE)
      it(`should stay ${asked} (never lowered to a code) on ${what}, with no saved login password offered`, async () => {
        const w = world(withPassword(facing(attrs)));

        await w.service.raise(SESSION, raise(asked));
        const request = await w.pending();

        should(request.fields[0]?.sensitivity).equal(asked);
        should(request.saved?.offers.filter(offer => offer.fills === 'password')).eql([]);
      });

  it('should mask a secret on a code-looking field from every read once it is delivered', async () => {
    const w = world(withPassword(facing(OTP)));
    await w.service.raise(SESSION, raise('secret'));
    const request = await w.pending();

    await w.service.deliver(
      SESSION,
      request.id,
      w.send(request, { fields: [{ field: 'code', padded: padInputValue('482913-UNIQUE') }] }),
      OWNER,
    );

    should(w.writes[0]?.values).eql(['482913-UNIQUE']);
    should(w.values.scrub(SESSION, 'the code was 482913-UNIQUE')).not.containEql('482913-UNIQUE');
  });

  it('should keep a label the agent wrote, on the code card a plain ask becomes', async () => {
    const w = world(withPassword(facing(OTP)));

    await w.service.raise(SESSION, raise('plain', 'Text message code'));

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

  it('should read "Card security code" as a card field when the page labels it so', async () => {
    const w = world(withPassword(facing({ name: 'f_9', label: 'Card security code', maxlength: '4' })));

    await w.service.raise(SESSION, raise('plain'));

    should((await w.pending()).fields[0]?.sensitivity).equal('secret');
  });

  it('should never offer a saved LOGIN password for a card number the agent asked as a secret', async () => {
    const w = world(withPassword(facing({ name: 'cardnumber', autocomplete: 'cc-number', inputmode: 'numeric' })));

    await w.service.raise(SESSION, raise('secret'));
    const request = await w.pending();

    should(request.fields[0]?.sensitivity).equal('secret');
    should(request.saved?.offers).eql([]);
    should(request.saved?.saves).be.undefined();
  });

  it('should refuse to type a saved login password into a card number, with nothing typed', async () => {
    const w = world(withPassword(facing({ name: 'cardnumber', autocomplete: 'cc-number', inputmode: 'numeric' })));
    await w.service.raise(SESSION, raise('secret'));
    const request = await w.pending();

    const refused = await w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    should(refused).not.be.undefined();
    should(w.writes).eql([]);
    should(w.fills).eql([]);
  });
});
