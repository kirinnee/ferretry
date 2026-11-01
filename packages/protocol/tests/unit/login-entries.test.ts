import { describe, expect, it } from 'bun:test';
import {
  fillRoleFor,
  LOGIN_HINT_PASSKEYS_OFF,
  LOGIN_METHODS,
  LoginDomainSchema,
  loginDomainsOf,
  LoginHintListSchema,
  loginHintSite,
  loginHintsFor,
  loginHintSummary,
  loginMethodOf,
  LoginMethodChangeSchema,
  LoginMethodSchema,
  loginMethodSentence,
  normalizedLoginDomain,
  InputSavedSchema,
  LOGIN_TOTP_WARNING,
  LoginEntryListSchema,
  LoginEntrySummarySchema,
  LoginMatchSchema,
  PutLoginEntryRequestSchema,
  RenameLoginEntryRequestSchema,
  suggestedLoginId,
  suggestedLoginLabel,
  TotpSeedSchema,
} from '../../src/lib/login-entries.ts';

const AT = '2026-10-31T09:00:00.000Z';
const SUMMARY = {
  id: 'GITHUB_KIRINNEE',
  label: 'GitHub (kirinnee)',
  match: ['github.com'],
  username: 'kirinnee',
  fields: { password: true, totp: false },
  createdAt: AT,
  updatedAt: AT,
};

describe('a saved login, as a client reads it', () => {
  it('should carry the label, the match, the plain username and which secret fields exist', () => {
    expect(LoginEntrySummarySchema.safeParse(SUMMARY).success).toBe(true);
  });

  it('should have no field for a password, a seed, a code, a length or a digest', () => {
    for (const leak of ['password', 'value', 'seed', 'code', 'length', 'digest'])
      expect(LoginEntrySummarySchema.safeParse({ ...SUMMARY, [leak]: 'hunter2-UNIQUE' }).success).toBe(false);
    expect(
      LoginEntrySummarySchema.safeParse({ ...SUMMARY, fields: { password: 'hunter2', totp: false } }).success,
    ).toBe(false);
  });

  it('should list entries with the store health, never a damaged store as an empty one', () => {
    expect(LoginEntryListSchema.safeParse({ v: 1, health: 'ready', entries: [SUMMARY] }).success).toBe(true);
    expect(
      LoginEntryListSchema.safeParse({ v: 1, health: 'damaged', diagnosis: 'the key is gone', entries: [] }).success,
    ).toBe(true);
  });
});

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

describe('changing an entry', () => {
  it('should take values IN, and null to remove a field', () => {
    expect(
      PutLoginEntryRequestSchema.safeParse({ label: 'sudo on kirin-box', password: 'correct-horse' }).success,
    ).toBe(true);
    expect(PutLoginEntryRequestSchema.safeParse({ username: null, password: null, totp: null }).success).toBe(true);
  });

  it('should refuse a password too short to mask safely, or one that would press keys', () => {
    expect(PutLoginEntryRequestSchema.safeParse({ password: 'short' }).success).toBe(false);
    expect(PutLoginEntryRequestSchema.safeParse({ password: 'long-enough\n' }).success).toBe(false);
  });

  it('should refuse a 2FA seed until the owner confirmed the warning', () => {
    const totp = { seed: 'JBSW Y3DP EHPK 3PXP' };
    const refused = PutLoginEntryRequestSchema.safeParse({ totp });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain(LOGIN_TOTP_WARNING);
    expect(PutLoginEntryRequestSchema.safeParse({ totp, totpAcknowledged: true }).success).toBe(true);
  });

  it('should normalise a base32 seed and refuse one that is not base32', () => {
    expect(TotpSeedSchema.parse('jbsw y3dp-ehpk 3pxp====')).toBe('JBSWY3DPEHPK3PXP');
    expect(TotpSeedSchema.safeParse('not-a-seed-0189!!').success).toBe(false);
    expect(TotpSeedSchema.safeParse('JBSW').success).toBe(false);
  });

  it('should rename to a valid handle only', () => {
    expect(RenameLoginEntryRequestSchema.safeParse({ to: 'SUDO_LAPTOP' }).success).toBe(true);
    expect(RenameLoginEntryRequestSchema.safeParse({ to: 'sudo laptop' }).success).toBe(false);
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
      expect(PutLoginEntryRequestSchema.safeParse({ method: { kind: 'sso', name } }).success).toBe(false);
    }
    expect(LoginMethodChangeSchema.safeParse({ kind: 'sso', name: 'Okta' }).success).toBe(true);
  });

  it('should judge only a change by the passkey words, so a stored name never makes a listing unreadable', () => {
    expect(LoginMethodSchema.safeParse({ kind: 'sso', name: 'Passkey' }).success).toBe(true);
    expect(LoginEntrySummarySchema.safeParse({ ...SUMMARY, method: { kind: 'sso', name: 'Passkey' } }).success).toBe(
      true,
    );
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

  it('should read an entry from before methods as a password one, signing in on its web hosts', () => {
    expect(loginMethodOf(SUMMARY)).toEqual({ kind: 'password' });
    expect(loginDomainsOf({ match: ['sudo@kirin-box', 'github.com', 'localhost:8443'] })).toEqual([
      'github.com',
      'localhost:8443',
    ]);
    expect(loginDomainsOf({ match: ['github.com'], domains: [] })).toEqual([]);
    expect(LoginEntrySummarySchema.safeParse({ ...SUMMARY, method: { kind: 'passkey' } }).success).toBe(false);
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

  it('should take a method and login domains in a change', () => {
    expect(PutLoginEntryRequestSchema.safeParse({ method: { kind: 'github' }, domains: ['github.com'] }).success).toBe(
      true,
    );
    expect(PutLoginEntryRequestSchema.safeParse({ method: { kind: 'passkey' } }).success).toBe(false);
    expect(PutLoginEntryRequestSchema.safeParse({ domains: ['*.github.com'] }).success).toBe(false);
  });
});

describe('the login hint a ferret reads', () => {
  const GOOGLE = {
    ...SUMMARY,
    id: 'GOOGLE_KIRIN',
    label: 'Google (kirin@)',
    match: ['accounts.google.com'],
    username: 'kirin@example.com',
  };
  const VERCEL = {
    ...SUMMARY,
    id: 'VERCEL',
    label: 'Vercel',
    match: ['vercel.com'],
    username: undefined,
    method: { kind: 'google' as const, via: 'GOOGLE_KIRIN' },
    domains: ['vercel.com'],
    fields: { password: false, totp: false },
  };

  it('should list the site login, then the provider login it goes via, once each', () => {
    const hints = loginHintsFor('vercel.com', [GOOGLE, VERCEL, SUMMARY]);
    expect(hints.map(hint => [hint.id, hint.role])).toEqual([
      ['VERCEL', 'site'],
      ['GOOGLE_KIRIN', 'provider'],
    ]);
    expect(hints[0]?.via).toEqual({ id: 'GOOGLE_KIRIN', label: 'Google (kirin@)' });
  });

  it('should drop the owner-tap count from what was observed (secrev-1271 L2)', () => {
    const fact = {
      at: 'github.com',
      surface: 'page' as const,
      identity: '0123456789abcdef',
      since: AT,
      masked: { value: true, observedAt: AT, count: 2 },
    };
    const plain = loginHintsFor('github.com', [{ ...SUMMARY, observed: [fact] }]);
    const tapped = loginHintsFor('github.com', [
      { ...SUMMARY, observed: [{ ...fact, tapped: { value: true, observedAt: AT, count: 2 } }] },
    ]);
    expect(JSON.stringify(tapped)).toBe(JSON.stringify(plain));
    expect(LoginHintListSchema.safeParse({ v: 1, site: 'github.com', hints: tapped, passkeys: 'off' }).success).toBe(
      true,
    );
  });

  it('should carry no secret field, and say passkeys are off', () => {
    const hints = loginHintsFor('github.com', [SUMMARY]);
    expect(LoginHintListSchema.safeParse({ v: 1, site: 'github.com', hints, passkeys: 'off' }).success).toBe(true);
    expect(JSON.stringify(hints)).not.toContain('fields');
    expect(
      LoginHintListSchema.safeParse({
        v: 1,
        site: 'github.com',
        hints: [{ ...hints[0], password: 'x' }],
        passkeys: 'off',
      }).success,
    ).toBe(false);
    expect(loginHintSummary('github.com', hints)).toContain(LOGIN_HINT_PASSKEYS_OFF);
    expect(loginHintSummary('github.com', hints)).toContain(
      "'GitHub (kirinnee)' (GITHUB_KIRINNEE): password on github.com",
    );
  });

  it('should tell the ferret to click the provider button for a provider login', () => {
    const summary = loginHintSummary('vercel.com', loginHintsFor('vercel.com', [GOOGLE, VERCEL]));
    expect(summary).toContain("Sign in with Google via 'Google (kirin@)': click that button");
    expect(summary).toContain('username kirin@example.com');
  });

  it('should match exactly and read a URL as its host', () => {
    expect(loginHintsFor('evilgithub.com', [SUMMARY])).toEqual([]);
    expect(loginHintsFor('api.github.com', [SUMMARY])).toEqual([]);
    expect(loginHintSite('https://GitHub.com/login')).toBe('github.com');
    expect(loginHintSite('sudo@kirin-box')).toBe('sudo@kirin-box');
    expect(loginHintSite('not a site')).toBeUndefined();
  });
});
