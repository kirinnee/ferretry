import { describe, it } from 'bun:test';
import should from 'should';
import { InputSavedSchema } from '../../../../daemon/lib/inputs/borrowed.ts';

/**
 * The saved-login offers an input card carries (`InputSavedSchema`, docs/input-requests.md, "The next time: one tap"),
 * parsed by the Vault, which is the enforcer: production parses THIS schema and `saved-logins.ts` decides the offers.
 */
const SI = 'si_0123456789abcdef';
const FACTOR = 'tf_0123456789ab';

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'GITHUB',
  label: 'GitHub',
  fills: 'password',
  matched: true,
  ...over,
});
const saved = (offers: readonly Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  InputSavedSchema.safeParse({ offers, ...over });

describe('the offers on an input card, as the Vault parses them', () => {
  it('I163 should never make a mismatch the primary, and keep a code off any hand-picked offer', () => {
    should(saved([offer({ matched: false, primary: true, why: 'only', signIn: SI })]).success).be.false();
    should(
      saved([
        offer({ primary: true, why: 'only', signIn: SI }),
        offer({ id: 'OTHER', primary: true, why: 'only', signIn: SI }),
      ]).success,
    ).be.false();
    should(saved([offer({ primary: true, signIn: SI })]).success).be.false();
    should(saved([offer({ primary: true, why: 'only' })]).success).be.false();
    should(saved([offer({ why: 'only' })]).success).be.false();
    const codes = [{ factor: FACTOR, label: 'Authenticator app' }];
    should(saved([offer({ fills: 'totp', signIn: SI, codes })]).success).be.true();
    should(saved([offer({ fills: 'totp', matched: false, signIn: SI, codes })]).success).be.false();
    should(saved([offer({ fills: 'password', signIn: SI, codes })]).success).be.false();
  });

  it('I164 should never make an account saved for another site the primary or a one-tap', () => {
    const elsewhere = ['liftoff.okta.com'];

    should(saved([offer({ matched: false, elsewhere })]).success).be.true();
    should(saved([offer({ matched: true, elsewhere })]).success).be.false();
    should(saved([offer({ matched: false, elsewhere, primary: true, why: 'only', signIn: SI })]).success).be.false();
  });
});
