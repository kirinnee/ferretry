import { describe, expect, it } from 'bun:test';
import { type AccountList, AccountListSchema, type InputSaved } from '@ferretry/protocol';
import {
  accountsBySite,
  defaultKeysOf,
  factorsWords,
  keyFacts,
  keyState,
  keyStateWords,
  lookAlikeGroups,
  pairsOf,
  readDefaultsText,
  scopedLinesFor,
  siteDefaultFor,
} from '../../src/lib/accounts-screen.ts';
import { startingAccount } from '../../src/lib/automatic-codes.ts';
import { splitOffers } from '../../src/lib/input-card.ts';
import { offer, saved } from '../support/input-fixtures.ts';

const AT = '2026-10-31T10:00:00.000Z';
const key = (id: string, over: object) => ({
  id: `tf_00000000000${id}`,
  kind: 'sms',
  label: 'Phone',
  endsWith: '42',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
  ...over,
});
const totp = (id: string, over: object = {}) =>
  key(id, {
    kind: 'totp',
    label: 'App',
    endsWith: undefined,
    automatic: true,
    params: { algorithm: 'SHA1', digits: 6, period: 30 },
    ...over,
  });

const account = (id: string, factors: readonly object[], signIns: readonly string[]) => ({
  id,
  label: id.toLowerCase(),
  fields: { password: true, totp: factors.some(each => (each as { automatic?: boolean }).automatic === true) },
  factors,
  signIns,
  createdAt: AT,
  updatedAt: AT,
});
const signIn = (id: string, accountId: string, place: object) => ({
  id,
  account: accountId,
  place,
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
});

const list = (): AccountList =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      account('ZED', [], ['si_0000000000000001']),
      account('ALPHA', [], ['si_0000000000000002', 'si_0000000000000003']),
      account('LONELY', [], []),
    ],
    signIns: [
      signIn('si_0000000000000001', 'ZED', { kind: 'site', domains: ['github.com'], match: [] }),
      signIn('si_0000000000000002', 'ALPHA', { kind: 'site', domains: ['github.com'], match: [] }),
      signIn('si_0000000000000003', 'ALPHA', { kind: 'site', domains: ['vercel.com'], match: ['app.vercel.com'] }),
    ],
  });

describe('accounts grouped by site', () => {
  it('should put each account under every site it signs in at, sites and accounts in order', () => {
    const { groups, unplaced } = accountsBySite(list());

    expect(groups.map(group => group.key)).toEqual(['github.com', 'vercel.com']);
    expect(groups[0]?.rows.map(row => row.account.id)).toEqual(['ALPHA', 'ZED']);
    expect(groups[1]?.rows.map(row => row.account.id)).toEqual(['ALPHA']);
    expect(unplaced.map(each => each.id)).toEqual(['LONELY']);
  });
});

describe('2FA keys as the screen reads them', () => {
  it('should give a key Ferretry makes codes from a state, and a key only the owner holds none', () => {
    const worked = totp('1', { verified: { worked: true, at: AT } }) as never;
    const failed = totp('2', { verified: { worked: false, at: AT } }) as never;
    const fresh = totp('3') as never;
    const phone = key('4', {}) as never;

    expect([worked, failed, fresh, phone].map(each => keyState(each))).toEqual([
      'verified',
      'failed',
      'unverified',
      undefined,
    ]);
    expect(keyStateWords(worked)).toBe('Worked on 2026-10-31');
    expect(keyStateWords(failed)).toContain('check the key');
    expect(keyStateWords(phone)).toBeUndefined();
  });

  it('should say only the last digits of a phone and count the keys Ferretry makes codes from', () => {
    expect(keyFacts(key('1', {}) as never)).toBe('Code sent to ••42');
    expect(factorsWords({ factors: [] })).toBe('no 2FA keys');
    expect(factorsWords({ factors: [key('1', {}), totp('2')] as never })).toBe(
      '2 2FA keys, Ferretry makes 1 of the codes',
    );
  });
});

describe('defaults', () => {
  it('should offer every host a sign-in names, a site’s match hosts included', () => {
    const place = { kind: 'site', domains: ['vercel.com'], match: ['app.vercel.com'] } as never;

    expect(defaultKeysOf(place)).toEqual(['vercel.com', 'app.vercel.com']);
  });

  it('should read the machine-wide line and the project and folder lines that name an account', () => {
    const read = readDefaultsText(
      'sites:\n  github.com: ALPHA\nprojects:\n  ferretry:\n    github.com: ALPHA\n    vercel.com: ZED\nfolders:\n  ~/scratch:\n    github.com: ZED\n',
      true,
    );
    if (read.kind !== 'read') throw new Error('should have read');

    expect(siteDefaultFor(read.file, 'github.com')).toBe('ALPHA');
    expect(scopedLinesFor(read.file, 'ALPHA', ['github.com', 'vercel.com'])).toEqual([
      { scope: 'projects', within: 'ferretry', key: 'github.com', account: 'ALPHA' },
    ]);
  });

  it('should read a missing or empty file as no defaults, but a file that does not parse as unreadable', () => {
    expect(readDefaultsText('', false)).toEqual({ kind: 'read', file: {} });
    expect(readDefaultsText('# nothing yet\n', true)).toEqual({ kind: 'read', file: {} });
    expect(readDefaultsText('sites: [oops', true).kind).toBe('unreadable');
    expect(readDefaultsText('sites:\n  github.com: not a handle\n', true).kind).toBe('unreadable');
  });
});

describe('look-alikes', () => {
  it('should keep only accounts still on the list, and only groups of two or more', () => {
    const groups = lookAlikeGroups([['ZED', 'ALPHA'], ['ZED', 'GONE'], ['ALPHA']], list());

    expect(groups.map(group => group.map(each => each.id))).toEqual([['ZED', 'ALPHA']]);
  });

  it('should pair every two accounts of a group once', () => {
    expect(pairsOf(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(pairsOf(['a'])).toEqual([]);
  });
});

describe('the one tap comes only from the daemon’s primary offer', () => {
  const card = (offers: ReturnType<typeof offer>[]): InputSaved => saved({ match: 'github.com', offers });

  it('should not make a matched, first-listed or hinted offer the one tap when none is primary', () => {
    const first = offer({ id: 'ALPHA', matched: true, hinted: true });
    const second = offer({ id: 'ZED', matched: true });
    const split = splitOffers(card([first, second]));

    expect(split.primary).toBeUndefined();
    expect(split.others).toHaveLength(2);
  });

  it('should start the codes panel on the primary account, and on none when several match and none is primary', () => {
    const accounts = [
      { id: 'ALPHA', label: 'alpha', places: [], seeds: 0 },
      { id: 'ZED', label: 'zed', places: [], seeds: 0 },
    ];

    expect(startingAccount(card([offer({ id: 'ZED', matched: true, primary: true })]), accounts)?.id).toBe('ZED');
    expect(startingAccount(card([offer({ id: 'ALPHA', matched: true, hinted: true })]), accounts)).toBeUndefined();
  });
});
