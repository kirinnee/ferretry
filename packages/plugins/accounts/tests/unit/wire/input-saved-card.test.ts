import { describe, expect, it } from 'bun:test';
import { InputSavedSchema, signInChoiceWords } from '../../../contract/routes/index.ts';

/**
 * The saved-login offers an input card carries (`InputSavedSchema`, docs/input-requests.md, "The next time: one tap"):
 * the shape the owner's card is drawn from. What the Vault's input service decides is its own; what the SHAPE allows is
 * Accounts'.
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

describe('Appendix D: the offers on an input card', () => {
  it('I161 should carry no value on any offer: a saved value never passes through the app', () => {
    expect(saved([offer({ primary: true, why: 'only', signIn: SI })]).success).toBe(true);
    for (const field of ['value', 'password', 'secret', 'seed', 'code', 'seal'])
      expect(saved([offer({ [field]: 'hunter2-hunter2' })]).success).toBe(false);
    expect(saved([offer()], { value: 'hunter2-hunter2' }).success).toBe(false);
    // An offer names an account and the sign-in it would use: the daemon redraws it at Send, nothing else rides along.
    const keys = Object.keys(InputSavedSchema.shape);
    for (const key of keys) expect(key).not.toMatch(/value|password|secret|seed|seal/iu);
  });

  it('I163 should never make a mismatch the primary, and keep a code off any hand-picked offer', () => {
    // Only a matched offer is the one-tap choice, and only one offer ever is.
    expect(saved([offer({ matched: false, primary: true, why: 'only', signIn: SI })]).success).toBe(false);
    expect(
      saved([
        offer({ primary: true, why: 'only', signIn: SI }),
        offer({ id: 'OTHER', primary: true, why: 'only', signIn: SI }),
      ]).success,
    ).toBe(false);
    // The primary names the sign-in it uses and says why it is first; nothing else says why.
    expect(saved([offer({ primary: true, signIn: SI })]).success).toBe(false);
    expect(saved([offer({ primary: true, why: 'only' })]).success).toBe(false);
    expect(saved([offer({ why: 'only' })]).success).toBe(false);
    // A code Ferretry makes is offered only on a matched offer that fills a code.
    const codes = [{ factor: FACTOR, label: 'Authenticator app' }];
    expect(saved([offer({ fills: 'totp', signIn: SI, codes })]).success).toBe(true);
    expect(saved([offer({ fills: 'totp', matched: false, signIn: SI, codes })]).success).toBe(false);
    expect(saved([offer({ fills: 'password', signIn: SI, codes })]).success).toBe(false);
  });

  it('I164 should never make an account saved for another site the primary or a one-tap, and say "Only account here" only when it is true', () => {
    const elsewhere = ['liftoff.okta.com'];
    expect(saved([offer({ matched: false, elsewhere })]).success).toBe(true);
    // Place keys leave only on an offer picked by hand: never on one that signs in here, never on the primary.
    expect(saved([offer({ matched: true, elsewhere })]).success).toBe(false);
    expect(saved([offer({ matched: false, elsewhere, primary: true, why: 'only', signIn: SI })]).success).toBe(false);
    // "Only account here" is the words of the `only` reason and of nothing else.
    expect(signInChoiceWords({ why: 'only' }, 'github.com')).toBe('Only account here');
    for (const why of ['ferret', 'project', 'folder', 'site'] as const)
      expect(signInChoiceWords({ why, project: 'ferretry' }, 'github.com')).not.toBe('Only account here');
  });
});
