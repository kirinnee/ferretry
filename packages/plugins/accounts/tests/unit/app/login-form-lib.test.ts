/** The sign-in form's shared decisions (`app/lib/login-form.ts`): the domains typed, the method a draft says, what stops a form going. */

import { describe, expect, it } from 'bun:test';
import { LOGIN_MATCH_MAX, LOGIN_PASSWORD_MIN_LENGTH } from '../../../contract/routes/index.ts';
import {
  handleFromLabel,
  METHOD_OPTIONS,
  methodOfDraft,
  parseDomains,
  passwordProblem,
  type SignInDraft,
  signInProblem,
} from '../../../app/lib/login-form.ts';

const draft = (over: Partial<SignInDraft> = {}): SignInDraft => ({
  method: 'password',
  ssoName: '',
  via: '',
  domains: 'github.com',
  ...over,
});

describe('the sign-in methods a form lists', () => {
  it('lists every method with the words the owner reads, and no passkey', () => {
    expect(METHOD_OPTIONS.map(option => option.kind)).toEqual([
      'password',
      'google',
      'github',
      'microsoft',
      'apple',
      'sso',
    ]);
    expect(METHOD_OPTIONS[0]?.label).toBe('Password');
  });
});

describe('the login domains typed', () => {
  it('reads each part as its host, splitting on commas and lines and dropping blanks', () => {
    expect(parseDomains('https://App.Vercel.com/login, accounts.google.com\n\n , github.com')).toEqual([
      'app.vercel.com',
      'accounts.google.com',
      'github.com',
    ]);
  });

  it('drops a part that is not a web host', () => {
    expect(parseDomains('github.com, not a host, ')).toEqual(['github.com']);
  });
});

describe('the method a draft says', () => {
  it('is a password with no name or provider', () => {
    expect(methodOfDraft(draft({ ssoName: 'Okta', via: 'GOOGLE' }))).toEqual({ kind: 'password' });
  });

  it('carries the provider login only for a method that goes via one', () => {
    expect(methodOfDraft(draft({ method: 'google', via: 'GOOGLE_ME' }))).toEqual({ kind: 'google', via: 'GOOGLE_ME' });
    expect(methodOfDraft(draft({ method: 'google' }))).toEqual({ kind: 'google' });
  });

  it('carries a trimmed name for an SSO, and the provider login when it has one', () => {
    expect(methodOfDraft(draft({ method: 'sso', ssoName: ' Okta ', via: 'OKTA' }))).toEqual({
      kind: 'sso',
      name: 'Okta',
      via: 'OKTA',
    });
  });
});

describe('what stops a sign-in form going', () => {
  it('lets a good draft go', () => {
    expect(signInProblem(draft())).toBeUndefined();
    expect(signInProblem(draft({ method: 'sso', ssoName: 'Okta', domains: '' }))).toBeUndefined();
  });

  it('asks an SSO to be named as its button says', () => {
    expect(signInProblem(draft({ method: 'sso', ssoName: '  ' }))).toBe(
      'Name the SSO provider, as its button says it.',
    );
  });

  it('gives the schema’s own words when the method is refused, such as a passkey SSO', () => {
    expect(signInProblem(draft({ method: 'sso', ssoName: 'Passkey' }))).toContain('passkeys are off');
  });

  it('names the first domain that is not a web host', () => {
    expect(signInProblem(draft({ domains: 'github.com, not a host' }))).toBe(
      '"not a host" is not a web host, like app.vercel.com.',
    );
  });

  it('allows at most the most login domains', () => {
    const domains = Array.from({ length: LOGIN_MATCH_MAX + 1 }, (_, index) => `site${String(index)}.test`).join(',');
    expect(signInProblem(draft({ domains }))).toBe(`At most ${LOGIN_MATCH_MAX} login domains.`);
  });
});

describe('a password typed on the form', () => {
  it('is fine empty (nothing to save) or long enough, and otherwise says the least', () => {
    expect(passwordProblem('')).toBeUndefined();
    expect(passwordProblem('x'.repeat(LOGIN_PASSWORD_MIN_LENGTH))).toBeUndefined();
    expect(passwordProblem('x'.repeat(LOGIN_PASSWORD_MIN_LENGTH - 1))).toBe(
      `At least ${LOGIN_PASSWORD_MIN_LENGTH} characters.`,
    );
  });
});

describe('the handle offered while a label is typed', () => {
  it('upper-cases, joins runs of other characters with one underscore, and trims them off the ends', () => {
    expect(handleFromLabel('GitHub (kirinnee)')).toBe('GITHUB_KIRINNEE');
    expect(handleFromLabel('  --work box--  ')).toBe('WORK_BOX');
  });

  it('keeps at most 64 characters', () => {
    expect(handleFromLabel('a'.repeat(100))).toHaveLength(64);
  });
});
