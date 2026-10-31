import { describe, expect, it } from 'bun:test';
import {
  fillRoleFor,
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
    expect(LoginEntrySummarySchema.safeParse({ ...SUMMARY, fields: { password: 'hunter2', totp: false } }).success).toBe(
      false,
    );
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
    expect(PutLoginEntryRequestSchema.safeParse({ label: 'sudo on kirin-box', password: 'correct-horse' }).success).toBe(
      true,
    );
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
