/** The Accounts screen's decisions (`app/lib/accounts-screen.ts`): how a key reads, what a default can name, which accounts look alike. */

import { describe, expect, it } from 'bun:test';
import {
  type AccountDefaultsFile,
  type AccountList,
  type Place,
  type SignInSummary,
  type TwoFactorKeySummary,
  TwoFactorKeySummarySchema,
} from '../../../contract/routes/index.ts';
import {
  accountsBySite,
  accountTitle,
  defaultKeysOf,
  factorsWords,
  fieldsWords,
  keyFacts,
  keyKindWords,
  keyState,
  keyStateWords,
  lookAlikeGroups,
  pairsOf,
  placeTitle,
  scopedLinesFor,
  signInMethodWords,
  siteDefaultFor,
  smsDigits,
} from '../../../app/lib/accounts-screen.ts';
import { list } from '../../support/app/accounts-fixtures.ts';

const AT = '2026-10-31T10:00:00.000Z';
const base = { id: 'tf_000000000001', label: 'Key', addedAt: AT, addedBy: 'owner' };
const key = (over: object): TwoFactorKeySummary =>
  TwoFactorKeySummarySchema.parse({ ...base, automatic: false, ...over });
const params = { algorithm: 'SHA1', digits: 6, period: 30 };
const automatic = (verified?: { worked: boolean; at: string }): TwoFactorKeySummary =>
  key({ kind: 'totp', automatic: true, params, ...(verified === undefined ? {} : { verified }) });

describe('how a 2FA key reads on the Accounts screen', () => {
  it('says who makes a TOTP key’s codes', () => {
    expect(keyFacts(automatic())).toBe('Ferretry makes the codes');
    expect(keyFacts(key({ kind: 'totp' }))).toBe('You type the codes yourself');
  });

  it('names where an SMS or email code goes only when the key says', () => {
    expect(keyFacts(key({ kind: 'sms', endsWith: '42' }))).toBe('Code sent to ••42');
    expect(keyFacts(key({ kind: 'sms' }))).toBe('Code sent by text');
    expect(keyFacts(key({ kind: 'email', to: 'me@example.test' }))).toBe('Code sent to me@example.test');
    expect(keyFacts(key({ kind: 'email' }))).toBe('Code sent by email');
  });

  it('names the phone app of a push key, or says only that it is approved on the phone', () => {
    expect(keyFacts(key({ kind: 'push', app: 'duo' }))).toBe('Approve in Duo');
    expect(keyFacts(key({ kind: 'push' }))).toBe('You approve it on your phone');
  });

  it('says a security key is tapped by the owner', () => {
    expect(keyFacts(key({ kind: 'security-key' }))).toBe('You tap it yourself');
  });

  it('words every kind of key', () => {
    expect((['totp', 'sms', 'email', 'push', 'security-key'] as const).map(kind => keyKindWords(kind))).toEqual([
      'Authenticator app',
      'Text message',
      'Email code',
      'Approve on a phone',
      'Security key',
    ]);
  });
});

describe('whether the last code Ferretry made from a key worked', () => {
  it('has no state for a key only the owner holds, or one that is not a TOTP key', () => {
    expect(keyState(key({ kind: 'totp' }))).toBeUndefined();
    expect(keyState(key({ kind: 'sms' }))).toBeUndefined();
    expect(keyStateWords(key({ kind: 'totp' }))).toBeUndefined();
    expect(keyStateWords(key({ kind: 'security-key' }))).toBeUndefined();
  });

  it('reads unused, worked and failed from the daemon’s record, with the day', () => {
    expect(keyState(automatic())).toBe('unused');
    expect(keyStateWords(automatic())).toBe('Not used yet');
    expect(keyState(automatic({ worked: true, at: AT }))).toBe('worked');
    expect(keyStateWords(automatic({ worked: true, at: AT }))).toBe('Last code worked on 2026-10-31');
    expect(keyState(automatic({ worked: false, at: AT }))).toBe('failed');
    expect(keyStateWords(automatic({ worked: false, at: AT }))).toBe('Last code did not work on 2026-10-31');
  });
});

describe('an account’s 2FA in one line', () => {
  it('counts the keys and how many Ferretry makes codes for', () => {
    expect(factorsWords({ factors: [] })).toBe('no 2FA keys');
    expect(factorsWords({ factors: [key({ kind: 'sms' })] })).toBe('1 2FA key');
    expect(factorsWords({ factors: [key({ kind: 'sms' }), key({ kind: 'security-key' })] })).toBe('2 2FA keys');
    expect(factorsWords({ factors: [key({ kind: 'sms' }), automatic()] })).toBe(
      '2 2FA keys, Ferretry makes 1 of the codes',
    );
  });

  it('says whether a password is saved, never the password', () => {
    expect(fieldsWords({ fields: { password: true } })).toBe('password saved');
    expect(fieldsWords({ fields: { password: false } })).toBe('no password saved');
  });
});

describe('the last digits an SMS key may name', () => {
  it('keeps 2 to 4 digits, with or without the mask dots a person copies', () => {
    expect(smsDigits('42')).toBe('42');
    expect(smsDigits(' ••1234 ')).toBe('1234');
    expect(smsDigits('**07')).toBe('07');
  });

  it('refuses anything else so nothing wrong is sent', () => {
    expect(smsDigits('4')).toBeUndefined();
    expect(smsDigits('12345')).toBeUndefined();
    expect(smsDigits('+65 1234')).toBeUndefined();
    expect(smsDigits('')).toBeUndefined();
  });
});

describe('how accounts and their sign-ins are named', () => {
  const github: Place = { kind: 'site', domains: ['github.com', 'gist.github.com'], match: [] };

  it('titles an account by its label and, when it has one, its username', () => {
    expect(accountTitle({ label: 'GitHub', username: 'kirinnee' })).toBe('GitHub · kirinnee');
    expect(accountTitle({ label: 'Google' })).toBe('Google');
  });

  it('names a sign-in method, and the provider it goes via only when it has one', () => {
    const first = list().signIns[0];
    if (first === undefined) throw new Error('the fixture has a sign-in');
    const signIn = (method: SignInSummary['method'], via?: SignInSummary['via']): SignInSummary => ({
      ...first,
      method,
      ...(via === undefined ? {} : { via }),
    });
    expect(signInMethodWords(signIn({ kind: 'password' }))).toBe('Password');
    expect(signInMethodWords(signIn({ kind: 'sso', name: 'Okta' }))).toBe('Sign in with Okta (SSO)');
    expect(
      signInMethodWords(signIn({ kind: 'sso', name: 'Okta' }, { account: { id: 'GOOGLE', label: 'Google (me)' } })),
    ).toBe("Sign in with Okta (SSO) via 'Google (me)'");
  });

  it('titles a place by the hosts it names', () => {
    expect(placeTitle(github)).toBe('github.com, gist.github.com');
    expect(placeTitle({ kind: 'site', domains: [], match: ['vercel.com'] })).toBe('vercel.com');
  });

  it('offers a default for every host the place names, a site’s match hosts included', () => {
    expect(defaultKeysOf({ kind: 'site', domains: ['github.com'], match: ['gist.github.com'] })).toEqual([
      'github.com',
      'gist.github.com',
    ]);
  });
});

describe('groups of sites and accounts', () => {
  it('groups sign-ins under their first host in alphabetical order, accounts by label, and lists accounts with no sign-in', () => {
    const grouped = accountsBySite(list());
    expect(grouped.groups.map(group => group.key)).toEqual(['github.com', 'vercel.com']);
    expect(grouped.groups[0]?.rows.map(row => row.account.label)).toEqual(['GitHub', 'GitHub (work)']);
    expect(grouped.unplaced.map(account => account.label)).toEqual(['Google']);
  });

  it('ignores a sign-in whose account is no longer on the list', () => {
    const full = list();
    const orphaned: AccountList = { ...full, accounts: full.accounts.filter(account => account.id !== 'VERCEL') };
    expect(accountsBySite(orphaned).groups.map(group => group.key)).toEqual(['github.com']);
  });
});

describe('the defaults file as the screen reads it', () => {
  const file: AccountDefaultsFile = {
    sites: { 'github.com': 'GITHUB' },
    projects: { ferretry: { 'github.com': 'GITHUB_WORK', 'vercel.com': 'VERCEL' } },
    folders: { '~/scratch': { 'github.com': 'GITHUB_WORK' } },
  };

  it('finds the machine-wide line for a key', () => {
    expect(siteDefaultFor(file, 'github.com')).toBe('GITHUB');
    expect(siteDefaultFor(file, 'vercel.com')).toBeUndefined();
    expect(siteDefaultFor({}, 'github.com')).toBeUndefined();
  });

  it('lists the project and folder lines that name an account on one of the keys, and never the machine-wide ones', () => {
    expect(scopedLinesFor(file, 'GITHUB_WORK', ['github.com'])).toEqual([
      { scope: 'projects', within: 'ferretry', key: 'github.com', account: 'GITHUB_WORK' },
      { scope: 'folders', within: '~/scratch', key: 'github.com', account: 'GITHUB_WORK' },
    ]);
    expect(scopedLinesFor(file, 'GITHUB', ['github.com'])).toEqual([]);
    expect(scopedLinesFor(file, 'GITHUB_WORK', ['vercel.com'])).toEqual([]);
  });
});

describe('accounts that look like one', () => {
  it('keeps the accounts still on the list and only groups of two or more', () => {
    const groups = lookAlikeGroups(
      [
        ['GITHUB', 'GITHUB_WORK'],
        ['VERCEL', 'GONE'],
      ],
      list(),
    );
    expect(groups.map(group => group.map(account => account.id))).toEqual([['GITHUB', 'GITHUB_WORK']]);
  });

  it('pairs every two items in a group once', () => {
    expect(pairsOf(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(pairsOf(['a'])).toEqual([]);
  });
});
