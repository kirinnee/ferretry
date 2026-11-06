import { describe, expect, it } from 'bun:test';
import {
  fillRoleFor,
  LOGIN_METHODS,
  LoginDomainSchema,
  loginHintSite,
  LoginMethodChangeSchema,
  LoginMethodSchema,
  loginMethodSentence,
  normalizedLoginDomain,
  InputSavedSchema,
  LoginPasswordSchema,
  LoginMatchSchema,
  providerNameOf,
  suggestedLoginId,
  suggestedLoginLabel,
  suggestedNewAccount,
  TotpSeedSchema,
} from '../../src/lib/login-entries.ts';

describe('what an entry matches', () => {
  it('should take a program@host or a web host, lowercase', () => {
    for (const match of ['sudo@kirin-box', 'ssh@build.example.com', 'github.com', 'localhost:8443'])
      expect(LoginMatchSchema.safeParse(match).success).toBe(true);
  });

  it('should refuse anything else', () => {
    for (const match of ['Sudo@Kirin', 'https://github.com', 'github.com/login', '', 'a b', '@host'])
      expect(LoginMatchSchema.safeParse(match).success).toBe(false);
  });
});

describe('a saved password and 2FA seed', () => {
  it('should refuse a password too short to mask safely, or one that would press keys', () => {
    expect(LoginPasswordSchema.safeParse('correct-horse').success).toBe(true);
    expect(LoginPasswordSchema.safeParse('short').success).toBe(false);
    expect(LoginPasswordSchema.safeParse('long-enough\n').success).toBe(false);
  });

  it('should normalise a base32 seed and refuse one that is not base32', () => {
    expect(TotpSeedSchema.parse('jbsw y3dp-ehpk 3pxp====')).toBe('JBSWY3DPEHPK3PXP');
    expect(TotpSeedSchema.safeParse('not-a-seed-0189!!').success).toBe(false);
    expect(TotpSeedSchema.safeParse('JBSW').success).toBe(false);
  });
});

describe('what an input card offers', () => {
  it('should carry offers with the daemon’s match decision, never a value', () => {
    const saved = {
      match: 'sudo@kirin-box',
      suggest: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
      saves: 'password',
      offers: [{ id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box', fills: 'password', matched: true }],
    };
    expect(InputSavedSchema.safeParse(saved).success).toBe(true);
    expect(InputSavedSchema.safeParse({ ...saved, offers: [{ ...saved.offers[0], value: 'x' }] }).success).toBe(false);
  });

  it('should take an older daemon’s offers, and a newer one’s primary only on one matched sign-in that says why', () => {
    // Arrange
    const older = { id: 'CLICKUP_A', label: 'ClickUp (a)', fills: 'password', matched: true };
    const primary = { ...older, signIn: 'si_0123456789abcdef', primary: true, why: 'project', project: 'ferretry' };
    const other = { ...older, id: 'CLICKUP_B', signIn: 'si_fedcba9876543210' };
    const card = (offers: object[]) => InputSavedSchema.safeParse({ offers }).success;

    // Act / Assert
    expect(card([older, { ...older, id: 'CLICKUP_B' }])).toBe(true);
    expect(card([primary, other])).toBe(true);
    expect(card([primary, { ...other, primary: true, why: 'site' }])).toBe(false);
    expect(card([{ ...primary, matched: false }])).toBe(false);
    expect(card([{ ...primary, why: undefined }])).toBe(false);
    expect(card([{ ...other, why: 'site' }])).toBe(false);
    expect(card([{ ...primary, signIn: undefined }])).toBe(false);
    expect(card([{ ...primary, why: 'site' }])).toBe(false);
    expect(card([{ ...primary, why: 'ferret', project: undefined }])).toBe(true);
    expect(card([{ ...older, matched: false, elsewhere: ['liftoff.okta.com'] }])).toBe(true);
    expect(card([{ ...older, matched: false, elsewhere: [] }])).toBe(true);
    expect(card([{ ...older, elsewhere: [] }])).toBe(false);
    expect(card([{ ...older, elsewhere: ['liftoff.okta.com'] }])).toBe(false);
  });

  it('should fill the password for a secret, the code for a private value and the username for plain', () => {
    expect(fillRoleFor('secret')).toBe('password');
    expect(fillRoleFor('private')).toBe('totp');
    expect(fillRoleFor('plain')).toBe('username');
  });

  it('should suggest a handle and a label from the target key', () => {
    expect(suggestedLoginId('sudo@kirin-box')).toBe('SUDO_KIRIN_BOX');
    expect(suggestedLoginId('github.com')).toBe('GITHUB_COM');
    expect(suggestedLoginId('1password.com')).toBe('LOGIN_1PASSWORD_COM');
    expect(suggestedLoginLabel('sudo@kirin-box')).toBe('sudo on kirin-box');
    expect(suggestedLoginLabel('github.com')).toBe('github.com');
  });

  it('should name a new account for its provider and its person, never as a site or an env var', () => {
    const none = new Set<string>();
    expect(suggestedNewAccount('accounts.google.com', 'ernest@atomi.tech', none)).toEqual({
      id: 'GOOGLE_ERNEST',
      label: 'Google · ernest@atomi.tech',
    });
    expect(suggestedNewAccount('accounts.google.com', undefined, none)).toEqual({ id: 'GOOGLE', label: 'Google' });
    expect(suggestedNewAccount('github.com', 'kirinnee', none)).toEqual({
      id: 'GITHUB_COM_KIRINNEE',
      label: 'github.com · kirinnee',
    });
    expect(suggestedNewAccount('sudo@kirin-box', undefined, none)).toEqual({
      id: 'SUDO_KIRIN_BOX',
      label: 'sudo on kirin-box',
    });
  });

  it('should never suggest a CLI name an account already has', () => {
    expect(suggestedNewAccount('accounts.google.com', 'b@x.com', new Set(['GOOGLE_B', 'GOOGLE_B_2'])).id).toBe(
      'GOOGLE_B_3',
    );
    const long = 'a'.repeat(80);
    const taken = suggestedNewAccount('accounts.google.com', long, new Set()).id;
    const next = suggestedNewAccount('accounts.google.com', long, new Set([taken])).id;
    expect(next.length).toBeLessThanOrEqual(64);
    expect(next.endsWith('_2')).toBe(true);
  });

  it('should know only a fixed list of providers', () => {
    expect(providerNameOf('accounts.google.com')).toBe('Google');
    expect(providerNameOf('login.microsoftonline.com')).toBe('Microsoft');
    expect(providerNameOf('liftoff.okta.com')).toBe('Okta');
    expect(providerNameOf('okta.com')).toBeUndefined();
    expect(providerNameOf('accounts.google.com.evil.example')).toBeUndefined();
  });
});

describe('how an entry signs in', () => {
  it('should offer a password and the identity providers, and no passkey', () => {
    expect([...LOGIN_METHODS]).toEqual(['password', 'google', 'github', 'microsoft', 'apple', 'sso']);
    for (const kind of ['passkey', 'webauthn', 'security-key', 'fido2'])
      expect(LoginMethodSchema.safeParse({ kind }).success).toBe(false);
  });

  it('should refuse an SSO named for a passkey or a hardware key, however it is spelt', () => {
    for (const name of [
      'Passkey',
      'pass-key',
      'Pass Key login',
      'WebAuthn',
      'FIDO2',
      'YubiKey',
      'Security key',
      'U2F',
    ]) {
      expect(LoginMethodChangeSchema.safeParse({ kind: 'sso', name }).success).toBe(false);
    }
    expect(LoginMethodChangeSchema.safeParse({ kind: 'sso', name: 'Okta' }).success).toBe(true);
  });

  it('should judge only a change by the passkey words, so a stored name never makes a listing unreadable', () => {
    expect(LoginMethodSchema.safeParse({ kind: 'sso', name: 'Passkey' }).success).toBe(true);
  });

  it('should need a name for other SSO only, and take a provider login only for a provider method', () => {
    expect(LoginMethodSchema.safeParse({ kind: 'sso' }).success).toBe(false);
    expect(LoginMethodSchema.safeParse({ kind: 'google', name: 'Okta' }).success).toBe(false);
    expect(LoginMethodSchema.safeParse({ kind: 'password', via: 'GOOGLE_KIRIN' }).success).toBe(false);
    expect(LoginMethodSchema.safeParse({ kind: 'google', via: 'GOOGLE_KIRIN' }).success).toBe(true);
  });

  it('should say a method as the owner reads it', () => {
    expect(loginMethodSentence({ kind: 'google', via: 'G' }, 'Google (kirin@…)')).toBe(
      "Sign in with Google via 'Google (kirin@…)'",
    );
    expect(loginMethodSentence({ kind: 'sso', name: 'Okta' }, undefined)).toBe('Sign in with Okta (SSO)');
    expect(loginMethodSentence({ kind: 'password' }, 'ignored')).toBe('Password');
  });

  it('should read a pasted URL as its host, and refuse a site that is not one', () => {
    expect(loginHintSite('https://GitHub.com/login')).toBe('github.com');
    expect(loginHintSite('sudo@kirin-box')).toBe('sudo@kirin-box');
    expect(loginHintSite('not a site')).toBeUndefined();
  });

  it('should take a login domain as a lowercase host, and read one from a pasted URL', () => {
    expect(LoginDomainSchema.safeParse('accounts.google.com').success).toBe(true);
    for (const bad of ['sudo@kirin-box', 'https://x.com', 'X.com', '*.google.com'])
      expect(LoginDomainSchema.safeParse(bad).success).toBe(false);
    expect(normalizedLoginDomain(' https://App.Vercel.com/login?next=/ ')).toBe('app.vercel.com');
    expect(normalizedLoginDomain('accounts.google.com')).toBe('accounts.google.com');
    expect(normalizedLoginDomain('*.google.com')).toBeUndefined();
    expect(normalizedLoginDomain('')).toBeUndefined();
  });
});
