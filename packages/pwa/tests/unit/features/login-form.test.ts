import { describe, expect, it } from 'bun:test';
import {
  handleFromLabel,
  METHOD_OPTIONS,
  methodOfDraft,
  parseDomains,
  passwordProblem,
  signInProblem,
} from '../../../src/lib/login-form.ts';

const signIn = { method: 'password' as const, ssoName: '', via: '', domains: 'github.com' };

describe('the sentences under the sign-in forms', () => {
  it('suggests a handle from the label', () => {
    expect(handleFromLabel('GitHub (kirinnee)')).toBe('GITHUB_KIRINNEE');
  });

  it('says a password is too short only once something is typed', () => {
    expect(passwordProblem('')).toBeUndefined();
    expect(passwordProblem('abc')).toBe('At least 8 characters.');
    expect(passwordProblem('long enough')).toBeUndefined();
  });
});

describe('how a login signs in', () => {
  it('says the method whole for a provider, and carries nothing extra for a password', () => {
    expect(methodOfDraft({ ...signIn, method: 'google', via: 'GOOGLE_KIRIN' })).toEqual({
      kind: 'google',
      via: 'GOOGLE_KIRIN',
    });
    expect(methodOfDraft({ ...signIn, method: 'google', via: '' })).toEqual({ kind: 'google' });
    expect(methodOfDraft({ ...signIn, method: 'sso', ssoName: ' Okta ' })).toEqual({ kind: 'sso', name: 'Okta' });
    expect(methodOfDraft({ ...signIn, method: 'password', via: 'GOOGLE_KIRIN' })).toEqual({ kind: 'password' });
  });

  it('needs a name for other SSO and refuses a passkey one', () => {
    expect(signInProblem({ ...signIn, method: 'sso' })).toContain('Name the SSO provider');
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'Passkey' })).toContain('passkeys are off');
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'my security key' })).toContain('passkeys are off');
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'Okta' })).toBeUndefined();
  });

  it('has no passkey among the methods', () => {
    expect(METHOD_OPTIONS.map(option => option.label)).toEqual([
      'Password',
      'Sign in with Google',
      'Sign in with GitHub',
      'Sign in with Microsoft',
      'Sign in with Apple',
      'Other SSO',
    ]);
  });

  it('parses and normalises login domains, and says which one is not a host', () => {
    expect(parseDomains(' https://App.Vercel.com/login , accounts.google.com,, ')).toEqual([
      'app.vercel.com',
      'accounts.google.com',
    ]);
    expect(signInProblem({ ...signIn, domains: 'app.vercel.com, not a host!' })).toBe(
      '"not a host!" is not a web host, like app.vercel.com.',
    );
  });
});
