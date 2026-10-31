import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ACCOUNT_HINT_FACTOR_NEXT,
  accountSeedFields,
  addTwoFactorKeySubject,
  automaticKeysInOfferOrder,
  MAX_FACTORS_PER_ACCOUNT,
  SealedNameSchema,
  sealedNamesOf,
  TwoFactorKeyHintSchema,
  TwoFactorKeyRecordSchema,
  twoFactorKeySummaryOf,
  TwoFactorKeySummarySchema,
  TwoFactorStageIdSchema,
  AccountDefaultsFileSchema,
  type AccountDefaultsFile,
  AccountHintListSchema,
  AccountHintSchema,
  accountHintsFor,
  accountHintSummary,
  AccountIndexDocumentSchema,
  AccountListSchema,
  type AccountList,
  AccountProposeCallSchema,
  AccountSummarySchema,
  chosenSignIn,
  matchedSignIns,
  MAX_SIGN_INS_PER_ACCOUNT,
  namesSignIn,
  pickOneWords,
  type Place,
  PlaceSchema,
  placeKeys,
  type SignInCandidate,
  signInChoiceWords,
  SignInIdSchema,
  signInMatches,
  SignInSummarySchema,
} from '../../src/lib/index.ts';

const AT = '2026-10-31T09:00:00.000Z';
const KEY = (n: number): string => `L${n.toString(16).toUpperCase().padStart(24, '0')}`;
const SI = (n: number): string => `si_${n.toString(16).padStart(16, '0')}`;

const site = (domains: string[], match: string[] = []): Place => ({ kind: 'site', domains, match });
const terminal = (tool: string, host: string, dest?: string): Place =>
  dest === undefined ? { kind: 'terminal', tool, host } : { kind: 'terminal', tool, host, dest };

describe('a sign-in id', () => {
  it('should be si_ and 16 lowercase hex digits, never an account handle', () => {
    expect(SignInIdSchema.safeParse('si_0123456789abcdef').success).toBe(true);
    for (const bad of [
      'si_0123456789ABCDEF',
      'si_0123456789abcde',
      'si_0123456789abcdef0',
      'GITHUB',
      'sx_0123456789abcdef',
    ])
      expect(SignInIdSchema.safeParse(bad).success).toBe(false);
    expect(namesSignIn('si_0123456789abcdef')).toBe(true);
    expect(namesSignIn('GITHUB_KIRINNEE')).toBe(false);
  });
});

describe('a place and the keys it is matched on (invariant 9)', () => {
  it('should give the keys the daemon derives for a target: the page host, program@host, ssh@destination', () => {
    expect(placeKeys(site(['github.com', 'localhost:8443'], ['github.com']))).toEqual(['github.com', 'localhost:8443']);
    expect(placeKeys(terminal('sudo', 'kirin-box'))).toEqual(['sudo@kirin-box']);
    expect(placeKeys(terminal('ssh', 'kirin-box', 'build.example.com'))).toEqual(['ssh@build.example.com']);
  });

  it('should match exactly: no look-alike, no parent or child domain, no other program, no other destination', () => {
    // Arrange
    const github = site(['github.com']);
    const sudo = terminal('sudo', 'kirin-box');
    const ssh = terminal('ssh', 'kirin-box', 'build.example.com');

    // Act / Assert
    expect(signInMatches(github, 'github.com')).toBe(true);
    for (const key of [
      'github.com.evil.example',
      'evil-github.com',
      'api.github.com',
      'com',
      'github.co',
      'github.com:443',
    ])
      expect(signInMatches(github, key)).toBe(false);
    expect(signInMatches(sudo, 'sudo@kirin-box')).toBe(true);
    for (const key of ['su@kirin-box', 'sudo@other-box', 'sudo@kirin-box.local', 'kirin-box'])
      expect(signInMatches(sudo, key)).toBe(false);
    expect(signInMatches(ssh, 'ssh@build.example.com')).toBe(true);
    for (const key of ['ssh@build.example.org', 'ssh@kirin-box', 'scp@build.example.com'])
      expect(signInMatches(ssh, key)).toBe(false);
    expect(signInMatches(github, undefined)).toBe(false);
  });

  it('should never match a page on what a site is FOR, only where it signs in', () => {
    const vercel = site(['accounts.google.com'], ['vercel.com']);
    expect(signInMatches(vercel, 'vercel.com')).toBe(false);
    expect(signInMatches(vercel, 'accounts.google.com')).toBe(true);
  });

  it('should refuse a place that is not one', () => {
    expect(PlaceSchema.safeParse(site([])).success).toBe(false);
    expect(PlaceSchema.safeParse(site(['GitHub.com'])).success).toBe(false);
    expect(PlaceSchema.safeParse(terminal('sudo', 'kirin-box', 'elsewhere')).success).toBe(false);
    expect(PlaceSchema.safeParse(terminal('Sudo', 'kirin-box')).success).toBe(false);
    expect(PlaceSchema.safeParse({ kind: 'site', domains: ['a.example'], match: [], extra: 1 }).success).toBe(false);
    expect(PlaceSchema.safeParse(terminal('scp', 'kirin-box', 'files.example.com')).success).toBe(true);
    // ssh, scp and sftp name where they go: without it, this machine's name would be read as the destination (L2).
    for (const tool of ['ssh', 'scp', 'sftp'])
      expect(PlaceSchema.safeParse(terminal(tool, 'kirin-box')).success).toBe(false);
  });
});

const account = (n: number, extra: object = {}) => ({
  key: KEY(n),
  label: `Account ${String(n)}`,
  seals: {},
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});
const signIn = (n: number, place: Place, extra: object = {}) => ({
  account: KEY(n),
  place,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});
const TF = (n: number): string => `tf_${n.toString(16).padStart(12, '0')}`;
const PARAMS = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
const totpKey = (id: string, extra: object = {}) => ({
  id,
  kind: 'totp',
  label: 'Authenticator app',
  addedAt: AT,
  addedBy: 'owner',
  ...extra,
});
const otherKey = (id: string, kind: string, label: string, extra: object = {}) => ({
  id,
  kind,
  label,
  addedAt: AT,
  addedBy: 'owner',
  ...extra,
});
const index = (accounts: Record<string, object | undefined>, signIns: Record<string, object>) => ({
  v: 2,
  accounts,
  signIns,
});

describe('the version 2 index and the store’s rules', () => {
  const GOOD = index(
    { GOOGLE: account(1), VERCEL: account(2), OTHER_VERCEL: account(3) },
    {
      [SI(1)]: signIn(1, site(['accounts.google.com'])),
      [SI(2)]: signIn(2, site(['vercel.com']), { method: { kind: 'google', viaKey: KEY(1) } }),
      [SI(3)]: signIn(2, terminal('vercel', 'kirin-box')),
      // A second account on the same site is two sign-ins there, which is allowed.
      [SI(4)]: signIn(3, site(['vercel.com'])),
    },
  );

  it('should accept an index that keeps every rule', () => {
    expect(AccountIndexDocumentSchema.safeParse(GOOD).success).toBe(true);
  });

  it('should refuse a second sign-in of ONE account at a place it already signs in at (invariant 17)', () => {
    // Arrange — the same login domain twice, and a login domain that is another sign-in's `match` host
    const twice = index(
      { A: account(1) },
      { [SI(1)]: signIn(1, site(['a.example'])), [SI(2)]: signIn(1, site(['a.example', 'b.example'])) },
    );
    const forAndAt = index(
      { A: account(1) },
      { [SI(1)]: signIn(1, site(['login.example'], ['a.example'])), [SI(2)]: signIn(1, site(['a.example'])) },
    );
    const terminalTwice = index(
      { A: account(1) },
      { [SI(1)]: signIn(1, terminal('sudo', 'kirin-box')), [SI(2)]: signIn(1, terminal('sudo', 'kirin-box')) },
    );

    // Act / Assert
    for (const document of [twice, forAndAt, terminalTwice]) {
      const parsed = AccountIndexDocumentSchema.safeParse(document);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('already signs in at');
    }
  });

  it('should refuse a sign-in of no account, and two handles sharing one key', () => {
    expect(
      AccountIndexDocumentSchema.safeParse(index({ A: account(1) }, { [SI(1)]: signIn(9, site(['a.example'])) }))
        .success,
    ).toBe(false);
    expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1), B: account(1) }, {})).success).toBe(false);
  });

  it('should refuse a via link to itself, to an account that is gone, to one with no site, or round in a circle', () => {
    const via = (key: string) => ({ method: { kind: 'google', viaKey: key } });
    const cases = [
      index({ A: account(1) }, { [SI(1)]: signIn(1, site(['a.example']), via(KEY(1))) }),
      index({ A: account(1) }, { [SI(1)]: signIn(1, site(['a.example']), via(KEY(9))) }),
      index(
        { A: account(1), B: account(2) },
        { [SI(1)]: signIn(1, site(['a.example']), via(KEY(2))), [SI(2)]: signIn(2, terminal('sudo', 'kirin-box')) },
      ),
      index(
        { A: account(1), B: account(2) },
        { [SI(1)]: signIn(1, site(['a.example']), via(KEY(2))), [SI(2)]: signIn(2, site(['b.example']), via(KEY(1))) },
      ),
    ];
    for (const document of cases) expect(AccountIndexDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('should refuse a password sign-in that goes via another account', () => {
    const document = index(
      { A: account(1), B: account(2) },
      {
        [SI(1)]: signIn(1, site(['a.example']), { method: { kind: 'password', viaKey: KEY(2) } }),
        [SI(2)]: signIn(2, site(['b.example'])),
      },
    );
    expect(AccountIndexDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('should refuse a seal that is not the account’s own, for its own field, or that two accounts share (L6)', () => {
    const own = (n: number, field: string, suffix = '00000001') => `${KEY(n)}_${field}_${suffix}`;
    const seeded = (n: number, seal: string, id = TF(n)) =>
      totpKey(id, { label: `App ${String(n)}`, seal, params: PARAMS });
    for (const accounts of [
      { A: account(1, { seals: { password: own(2, 'PASSWORD') } }), B: account(2) },
      { A: account(1, { seals: { password: own(1, 'TOTP') } }) },
      // A 2FA key's seed is the account's own TOTP seal: not another account's, never a password.
      { A: account(1, { factors: [seeded(1, own(2, 'TOTP'))] }), B: account(2) },
      { A: account(1, { factors: [seeded(1, own(1, 'PASSWORD'))] }) },
      // One seal named twice: by two accounts' keys, by two keys of one account, or by a password and a key.
      {
        A: account(1, { factors: [seeded(1, own(1, 'TOTP'))] }),
        B: account(2, { factors: [seeded(2, own(1, 'TOTP'))] }),
      },
      { A: account(1, { factors: [seeded(1, own(1, 'TOTP')), seeded(2, own(1, 'TOTP'))] }) },
      // The old single-seed fields are gone from the index.
      { A: account(1, { seals: { totp: own(1, 'TOTP') } }) },
      { A: account(1, { totp: PARAMS }) },
    ])
      expect(AccountIndexDocumentSchema.safeParse(index(accounts, {})).success).toBe(false);
    expect(
      AccountIndexDocumentSchema.safeParse(
        index(
          {
            A: account(1, {
              seals: { password: own(1, 'PASSWORD') },
              factors: [seeded(1, own(1, 'TOTP')), seeded(2, own(1, 'TOTP', '00000002'))],
            }),
          },
          {},
        ),
      ).success,
    ).toBe(true);
  });

  it('should keep a 2FA key’s code parameters exactly with its seed, and check by use only a key with one', () => {
    const seal = `${KEY(1)}_TOTP_00000001`;
    for (const key of [
      totpKey(TF(1), { seal }),
      totpKey(TF(1), { params: PARAMS }),
      totpKey(TF(1), { verified: { worked: true, at: AT } }),
    ])
      expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: [key] }) }, {})).success).toBe(
        false,
      );
    for (const key of [
      totpKey(TF(1)),
      totpKey(TF(1), { seal, params: PARAMS, verified: { worked: false, at: AT }, issuer: 'GitHub' }),
    ])
      expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: [key] }) }, {})).success).toBe(true);
  });

  it('should refuse a 2FA key id two keys share anywhere in the index, and two labels one account would read alike', () => {
    for (const accounts of [
      {
        A: account(1, { factors: [otherKey(TF(1), 'sms', 'Phone')] }),
        B: account(2, { factors: [otherKey(TF(1), 'push', 'Okta')] }),
      },
      { A: account(1, { factors: [otherKey(TF(1), 'sms', 'Phone'), otherKey(TF(2), 'email', ' PHONE ')] }) },
    ])
      expect(AccountIndexDocumentSchema.safeParse(index(accounts, {})).success).toBe(false);
    // The same label on two accounts is fine: a card names the key within its own account.
    expect(
      AccountIndexDocumentSchema.safeParse(
        index(
          {
            A: account(1, { factors: [otherKey(TF(1), 'sms', 'Phone')] }),
            B: account(2, { factors: [otherKey(TF(2), 'sms', 'Phone')] }),
          },
          {},
        ),
      ).success,
    ).toBe(true);
  });

  it('should keep at most 8 2FA keys on an account, and at most 4 of them with a seed', () => {
    const seeds = (count: number) =>
      Array.from({ length: count }, (_, n) =>
        totpKey(TF(n + 1), { label: `App ${String(n)}`, seal: `${KEY(1)}_TOTP_0000000${String(n)}`, params: PARAMS }),
      );
    const many = Array.from({ length: MAX_FACTORS_PER_ACCOUNT + 1 }, (_, n) =>
      otherKey(TF(n + 1), 'sms', `Phone ${String(n)}`),
    );
    expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: seeds(4) }) }, {})).success).toBe(
      true,
    );
    expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: seeds(5) }) }, {})).success).toBe(
      false,
    );
    expect(
      AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: many.slice(0, 8) }) }, {})).success,
    ).toBe(true);
    expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: many }) }, {})).success).toBe(false);
  });

  it('should refuse a key of a kind it does not know, a value where none may be, and a whole phone number', () => {
    for (const key of [
      otherKey(TF(1), 'voice', 'Phone'),
      { ...otherKey(TF(1), 'sms', 'Phone'), seal: `${KEY(1)}_TOTP_00000001` },
      { ...otherKey(TF(1), 'sms', 'Phone'), endsWith: '+15551234567' },
      { ...otherKey(TF(1), 'push', 'Okta'), app: 'authy' },
      { ...otherKey(TF(1), 'sms', 'Phone'), addedBy: 'ferret' },
      { ...otherKey(TF(1), 'sms', 'Phone'), id: 'tf_XYZ' },
      { ...otherKey(TF(1), 'sms', 'Phone'), label: 'Phone‮' },
    ])
      expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1, { factors: [key] }) }, {})).success).toBe(
        false,
      );
  });

  it('should refuse a stored recipe a recipe may not be (L6)', () => {
    for (const recipe of ['steps <<<recipe inside', 'zero\u200bwidth'])
      expect(
        AccountIndexDocumentSchema.safeParse(
          index({ A: account(1) }, { [SI(1)]: signIn(1, site(['a.example']), { recipe }) }),
        ).success,
      ).toBe(false);
    expect(
      AccountIndexDocumentSchema.safeParse(
        index({ A: account(1) }, { [SI(1)]: signIn(1, site(['a.example']), { recipe: 'Open a.example.' }) }),
      ).success,
    ).toBe(true);
  });

  it('should refuse more accounts, or more sign-ins in all, than the store keeps', () => {
    // Arrange
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`A${String(n)}`, account(n)]));
    const spread = Object.fromEntries(
      Array.from({ length: 513 }, (_, n) => [SI(n), signIn(n % 33, terminal(`tool${String(n)}`, 'kirin-box'))]),
    );
    const owners = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`A${String(n)}`, account(n)]));

    // Act / Assert
    expect(AccountIndexDocumentSchema.safeParse(index(many, {})).error?.issues[0]?.message).toContain(
      'at most 256 accounts',
    );
    expect(AccountIndexDocumentSchema.safeParse(index(owners, spread)).error?.issues[0]?.message).toContain(
      'at most 512 sign-ins',
    );
  });

  it('should refuse more sign-ins on one account than the limit', () => {
    const signIns = Object.fromEntries(
      Array.from({ length: MAX_SIGN_INS_PER_ACCOUNT + 1 }, (_, n) => [
        SI(n),
        signIn(1, terminal(`tool${String(n)}`, 'kirin-box')),
      ]),
    );
    expect(AccountIndexDocumentSchema.safeParse(index({ A: account(1) }, signIns)).success).toBe(false);
  });

  it('should refuse a version 1 index and an unknown field, so nothing is half-read', () => {
    expect(AccountIndexDocumentSchema.safeParse({ ...GOOD, v: 1 }).success).toBe(false);
    expect(AccountIndexDocumentSchema.safeParse({ ...GOOD, entries: {} }).success).toBe(false);
  });
});

const candidate = (n: number, accountId: string, place: Place): SignInCandidate => ({
  id: SI(n),
  account: accountId,
  place,
});
const CLICKUP_A = candidate(1, 'CLICKUP_A', site(['app.clickup.com']));
const CLICKUP_B = candidate(2, 'CLICKUP_B', site(['app.clickup.com']));
// An account that does NOT sign in on app.clickup.com: every rule naming it must be ignored there.
const ELSEWHERE = candidate(3, 'CLICKUP_C', site(['other.clickup.com'], ['app.clickup.com']));
const ALL = [CLICKUP_A, CLICKUP_B, ELSEWHERE];
const KEY_HERE = 'app.clickup.com';
const FERRETRY = { id: 'p_ferretry', name: 'ferretry', nameIsUnique: true };

describe('which sign-in a card offers first (invariants 10 and 11)', () => {
  it('should offer no primary when two or more matched and nothing chose one', () => {
    // On main the card promoted the first matched entry by label; now the owner picks.
    expect(chosenSignIn(KEY_HERE, ALL)).toBeUndefined();
    expect(pickOneWords(2)).toBe('Pick one: 2 accounts sign in here');
  });

  it('should offer the only matched sign-in', () => {
    expect(chosenSignIn(KEY_HERE, [CLICKUP_B, ELSEWHERE])).toEqual({ signIn: SI(2), why: 'only' });
  });

  it('should put the ferret’s pick first, by account handle or by sign-in id', () => {
    expect(chosenSignIn(KEY_HERE, ALL, { hint: 'CLICKUP_B' })).toEqual({ signIn: SI(2), why: 'ferret' });
    expect(chosenSignIn(KEY_HERE, ALL, { hint: SI(1) })).toEqual({ signIn: SI(1), why: 'ferret' });
  });

  it('should never promote a sign-in the daemon did not match, whoever names it', () => {
    // Arrange — the hint, the project, the folder and the site line all name the account with no sign-in here
    const defaults: AccountDefaultsFile = {
      sites: { [KEY_HERE]: 'CLICKUP_C' },
      projects: { ferretry: { [KEY_HERE]: 'CLICKUP_C' } },
      folders: { '/work': { [KEY_HERE]: 'CLICKUP_C' } },
    };

    // Act / Assert
    expect(chosenSignIn(KEY_HERE, ALL, { hint: 'CLICKUP_C', defaults, project: FERRETRY })).toBeUndefined();
    expect(chosenSignIn(KEY_HERE, ALL, { hint: SI(3), defaults, folder: '/work' })).toBeUndefined();
    // Even a caller that hands in ONLY non-matching sign-ins gets nothing back.
    expect(chosenSignIn(KEY_HERE, [ELSEWHERE], { hint: 'CLICKUP_C', defaults })).toBeUndefined();
    expect(matchedSignIns(KEY_HERE, ALL)).toEqual([CLICKUP_A, CLICKUP_B]);
  });

  it('should take the project default, by project id or by its unique name, and say which project', () => {
    const byId = { projects: { p_ferretry: { [KEY_HERE]: 'CLICKUP_B' } } };
    const byName = { projects: { ferretry: { [KEY_HERE]: 'CLICKUP_A' } } };
    expect(chosenSignIn(KEY_HERE, ALL, { project: FERRETRY, defaults: byId })).toEqual({
      signIn: SI(2),
      why: 'project',
      project: 'ferretry',
    });
    expect(chosenSignIn(KEY_HERE, ALL, { project: FERRETRY, defaults: byName })).toEqual({
      signIn: SI(1),
      why: 'project',
      project: 'ferretry',
    });
    // Two projects share the name: the name line is ambiguous and ignored.
    expect(
      chosenSignIn(KEY_HERE, ALL, { project: { ...FERRETRY, nameIsUnique: false }, defaults: byName }),
    ).toBeUndefined();
  });

  it('should order the ferret over the project over the site default', () => {
    const defaults = { sites: { [KEY_HERE]: 'CLICKUP_A' }, projects: { ferretry: { [KEY_HERE]: 'CLICKUP_B' } } };
    expect(chosenSignIn(KEY_HERE, ALL, { defaults })).toEqual({ signIn: SI(1), why: 'site' });
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, project: FERRETRY })).toEqual({
      signIn: SI(2),
      why: 'project',
      project: 'ferretry',
    });
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, project: FERRETRY, hint: 'CLICKUP_A' })).toEqual({
      signIn: SI(1),
      why: 'ferret',
    });
  });

  it('should read a default line on a site’s match host as that site’s', () => {
    // Arrange — two accounts sign in on accounts.google.com; one is for vercel.com
    const google = candidate(1, 'GOOGLE_A', site(['accounts.google.com']));
    const vercel = candidate(2, 'GOOGLE_B', site(['accounts.google.com'], ['vercel.com']));

    // Act / Assert
    expect(
      chosenSignIn('accounts.google.com', [google, vercel], { defaults: { sites: { 'vercel.com': 'GOOGLE_B' } } }),
    ).toEqual({
      signIn: SI(2),
      why: 'site',
    });
  });

  it('should choose nothing when two lines name two matched sign-ins, whatever order they were listed in (L1)', () => {
    // Arrange — both sign in on accounts.google.com; one is for vercel.com, the other for netlify.com
    const forVercel = candidate(1, 'GOOGLE_A', site(['accounts.google.com'], ['vercel.com']));
    const forNetlify = candidate(2, 'GOOGLE_B', site(['accounts.google.com'], ['netlify.com']));
    const defaults = { sites: { 'vercel.com': 'GOOGLE_A', 'netlify.com': 'GOOGLE_B' } };

    // Act / Assert
    expect(chosenSignIn('accounts.google.com', [forVercel, forNetlify], { defaults })).toBeUndefined();
    expect(chosenSignIn('accounts.google.com', [forNetlify, forVercel], { defaults })).toBeUndefined();
    // A line on the key itself still decides.
    expect(
      chosenSignIn('accounts.google.com', [forNetlify, forVercel], {
        defaults: { sites: { ...defaults.sites, 'accounts.google.com': 'GOOGLE_B' } },
      }),
    ).toEqual({ signIn: SI(2), why: 'site' });
  });

  it('should choose nothing for a handle that two matched sign-ins share (a damaged list), never the first', () => {
    const twice = [CLICKUP_A, { ...CLICKUP_A, id: SI(9) }];
    expect(chosenSignIn(KEY_HERE, twice, { hint: 'CLICKUP_A' })).toBeUndefined();
    expect(chosenSignIn(KEY_HERE, twice, { defaults: { sites: { [KEY_HERE]: 'CLICKUP_A' } } })).toBeUndefined();
  });

  it('should use no folder line or folder with a . or .. segment', () => {
    const defaults = {
      folders: { '/work/../home/kirin': { [KEY_HERE]: 'CLICKUP_A' }, '/srv': { [KEY_HERE]: 'CLICKUP_B' } },
    };
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, folder: '/home/kirin/x' })).toBeUndefined();
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, folder: '/srv/./app' })).toBeUndefined();
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, folder: '/srv/app' })).toEqual({ signIn: SI(2), why: 'folder' });
  });

  it('should use the longest folder line for an Unfiled session, on a path boundary, and not for a project one', () => {
    // Arrange
    const defaults = {
      folders: {
        '~/Workspace': { [KEY_HERE]: 'CLICKUP_A' },
        '~/Workspace/personal/': { [KEY_HERE]: 'CLICKUP_B' },
      },
    };
    const home = '/home/kirin';

    // Act / Assert
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, home, folder: '/home/kirin/Workspace/personal/scratch' })).toEqual({
      signIn: SI(2),
      why: 'folder',
    });
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, home, folder: '/home/kirin/Workspace/personal-x' })).toEqual({
      signIn: SI(1),
      why: 'folder',
    });
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, home, folder: '/home/kirin/Workspaces' })).toBeUndefined();
    expect(
      chosenSignIn(KEY_HERE, ALL, { defaults, home, folder: '/home/kirin/Workspace/personal', project: FERRETRY }),
    ).toBeUndefined();
    // Without a home to expand against, a ~ line is no line.
    expect(chosenSignIn(KEY_HERE, ALL, { defaults, folder: '/home/kirin/Workspace' })).toBeUndefined();
  });

  it('should choose nothing for a target with no key', () => {
    expect(chosenSignIn(undefined, ALL, { hint: 'CLICKUP_A' })).toBeUndefined();
  });

  it('should say why in a few words', () => {
    expect(signInChoiceWords({ why: 'ferret' }, KEY_HERE)).toBe('Ferret chose this');
    expect(signInChoiceWords({ why: 'project', project: 'ferretry' }, KEY_HERE)).toBe('Default for ferretry');
    expect(signInChoiceWords({ why: 'folder' }, KEY_HERE)).toBe('Default for this folder');
    expect(signInChoiceWords({ why: 'site' }, KEY_HERE)).toBe('Default for app.clickup.com');
    expect(signInChoiceWords({ why: 'only' }, KEY_HERE)).toBe('Only account here');
  });
});

const summary = (id: string, label: string, signIns: string[], fields = { password: true, totp: false }) => ({
  id,
  label,
  username: 'kirin@example.com',
  fields,
  factors: [],
  signIns,
  createdAt: AT,
  updatedAt: AT,
});
const signInSummary = (n: number, accountId: string, place: Place, extra: object = {}) => ({
  id: SI(n),
  account: accountId,
  place,
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const LIST: AccountList = AccountListSchema.parse({
  v: 1,
  health: 'ready',
  accounts: [
    summary('GOOGLE', 'Google (kirin)', [SI(1)]),
    summary('VERCEL', 'Vercel (kirin)', [SI(2)]),
    summary('VERCEL_WORK', 'Vercel (work)', [SI(3)]),
    summary('UNRELATED', 'Unrelated', [SI(4)]),
  ],
  signIns: [
    signInSummary(1, 'GOOGLE', site(['accounts.google.com'])),
    signInSummary(2, 'VERCEL', site(['accounts.google.com'], ['vercel.com']), {
      method: { kind: 'google', via: 'GOOGLE' },
      via: { account: { id: 'GOOGLE', label: 'Google (kirin)' }, signIn: SI(1) },
      recipe: 'Continue with Google, then [[GOOGLE]].',
      recipeVersion: 2,
      autoApplyRecipe: true,
      proposals: [{ id: 'rp_0123456789abcdef', recipe: 'x', why: 'y', sessionId: 's', proposedAt: AT }],
    }),
    signInSummary(3, 'VERCEL_WORK', site(['vercel.com']), {
      observed: [
        {
          at: 'vercel.com',
          surface: 'page',
          identity: '0123456789abcdef',
          since: AT,
          masked: { value: true, observedAt: AT, count: 3 },
        },
      ],
    }),
    signInSummary(4, 'UNRELATED', site(['vercel.com.evil.example'])),
  ],
});

describe('what a ferret may learn about signing in (account.hint)', () => {
  it('should list every sign-in naming the site exactly, then the provider sign-ins they lead to', () => {
    // Act
    const hints = accountHintsFor('vercel.com', LIST);

    // Assert
    expect(hints.map(hint => [hint.signIn, hint.role])).toEqual([
      [SI(2), 'site'],
      [SI(3), 'site'],
      [SI(1), 'provider'],
    ]);
    expect(AccountHintListSchema.safeParse({ v: 1, site: 'vercel.com', hints, passkeys: 'off' }).success).toBe(true);
  });

  it('should never say which secret fields an account holds (invariant 2)', () => {
    // Arrange — the same account twice, once with a password and a 2FA seed, once with nothing sealed
    const key = { id: TF(1), kind: 'totp', label: 'Authenticator app', addedAt: AT, addedBy: 'owner' };
    const withSecrets = AccountListSchema.parse({
      ...LIST,
      accounts: LIST.accounts.map(account =>
        account.id === 'VERCEL_WORK'
          ? {
              ...account,
              fields: { password: true, totp: true },
              totp: PARAMS,
              factors: [{ ...key, automatic: true, params: PARAMS, verified: { worked: true, at: AT } }],
            }
          : account,
      ),
    });
    const withNothing = AccountListSchema.parse({
      ...LIST,
      accounts: LIST.accounts.map(account =>
        account.id === 'VERCEL_WORK'
          ? { ...account, fields: { password: false, totp: false }, factors: [{ ...key, automatic: false }] }
          : account,
      ),
    });

    // Act
    const one = accountHintsFor('vercel.com', withSecrets);
    const other = accountHintsFor('vercel.com', withNothing);

    // Assert — and a TOTP key reads the same whether Ferretry holds its seed or the owner does (invariant 13)
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
    expect(accountHintSummary('vercel.com', one)).toBe(accountHintSummary('vercel.com', other));
    expect(one.find(hint => hint.account.id === 'VERCEL_WORK')?.factors).toEqual([
      { id: TF(1), kind: 'totp', label: 'Authenticator app' },
    ]);
  });

  it('should list an account’s 2FA keys by id, kind and label only, and nothing more of them', () => {
    // Arrange
    const keys = [
      {
        id: TF(1),
        kind: 'push',
        label: 'Okta Verify on Pixel',
        addedAt: AT,
        addedBy: 'owner',
        automatic: false,
        app: 'okta-verify',
      },
      { id: TF(2), kind: 'sms', label: 'Phone ••42', addedAt: AT, addedBy: 'owner', automatic: false, endsWith: '42' },
      {
        id: TF(3),
        kind: 'email',
        label: 'Work inbox',
        addedAt: AT,
        addedBy: 'owner',
        automatic: false,
        to: 'kirin@example.com',
      },
      {
        id: TF(4),
        kind: 'totp',
        label: 'Authy',
        addedAt: AT,
        addedBy: 'migration',
        automatic: true,
        params: PARAMS,
        issuer: 'Vercel',
        accountName: 'kirin',
      },
    ];
    const list = AccountListSchema.parse({
      ...LIST,
      accounts: LIST.accounts.map(account =>
        account.id === 'VERCEL_WORK'
          ? { ...account, fields: { password: true, totp: true }, totp: PARAMS, factors: keys }
          : account,
      ),
    });

    // Act
    const hint = accountHintsFor('vercel.com', list).find(candidate => candidate.account.id === 'VERCEL_WORK');
    const line = accountHintSummary('vercel.com', hint === undefined ? [] : [hint]);

    // Assert
    expect(hint?.factors).toEqual(keys.map(({ id, kind, label }) => ({ id, kind, label })) as never);
    expect(line).toContain(
      `2FA: 'Okta Verify on Pixel' (push) [${TF(1)}], 'Phone ••42' (sms) [${TF(2)}], 'Work inbox' (email) [${TF(3)}], 'Authy' (totp) [${TF(4)}].`,
    );
    for (const secretish of ['okta-verify', 'kirin@example.com', 'Vercel', 'SHA1', 'automatic', 'migration'])
      expect(JSON.stringify(hint?.factors)).not.toContain(secretish);
    // How to use a key is not said until the request tools take `factor` and `push`.
    expect(line).not.toContain(ACCOUNT_HINT_FACTOR_NEXT);
    // An account with no keys has no list, rather than an empty one.
    expect(accountHintsFor('vercel.com', LIST).every(other => other.factors === undefined)).toBe(true);
    // A hint's key is strict: a seal, parameters or `automatic` cannot ride along.
    for (const extra of [
      { automatic: true },
      { params: PARAMS },
      { seal: `${KEY(1)}_TOTP_00000001` },
      { endsWith: '42' },
    ])
      expect(TwoFactorKeyHintSchema.safeParse({ id: TF(1), kind: 'totp', label: 'Authy', ...extra }).success).toBe(
        false,
      );
  });

  it('should carry no fields, 2FA parameters, seals, keep-apart pairs, auto-apply, proposals or times', () => {
    // Arrange
    const hints = accountHintsFor('vercel.com', LIST);
    const [first] = hints;

    // Assert
    for (const hint of hints)
      for (const key of [
        'fields',
        'totp',
        'seals',
        'apartFrom',
        'autoApplyRecipe',
        'proposals',
        'createdAt',
        'updatedAt',
        'groups',
      ])
        expect(Object.keys(hint)).not.toContain(key);
    for (const extra of [
      { fields: { password: true, totp: false } },
      { totp: { algorithm: 'SHA1', digits: 6, period: 30 } },
      { autoApplyRecipe: true },
      { apartFrom: [] },
      { proposals: [] },
    ])
      expect(AccountHintSchema.safeParse({ ...first, ...extra }).success).toBe(false);
  });

  it('should say why a sign-in would be first for the calling session, from the same function the card uses', () => {
    // Arrange
    const context = { defaults: { sites: { 'vercel.com': 'VERCEL_WORK' } } };

    // Act
    const hints = accountHintsFor('vercel.com', LIST, context);

    // Assert
    expect(hints.find(hint => hint.signIn === SI(3))?.default).toEqual({ by: 'site' });
    expect(hints.filter(hint => hint.default !== undefined)).toHaveLength(1);
    expect(accountHintSummary('vercel.com', hints)).toContain(
      `'Vercel (work)' (VERCEL_WORK) as kirin@example.com [${SI(3)}]: password on vercel.com. Default for vercel.com.`,
    );
  });

  // Two accounts sign in on shared.example; only ONE of them holds a password.
  const SHARED: AccountList = AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      summary('HAS_PASSWORD', 'Has a password', [SI(1)]),
      summary('NO_PASSWORD', 'No password', [SI(2)], { password: false, totp: false }),
    ],
    signIns: [
      signInSummary(1, 'HAS_PASSWORD', site(['shared.example'])),
      signInSummary(2, 'NO_PASSWORD', site(['shared.example'])),
    ],
  });

  it('should never turn a ferret’s pick into a hint default, even if a caller passes one', () => {
    const context = { hint: 'HAS_PASSWORD' } as Parameters<typeof accountHintsFor>[2];
    expect(accountHintsFor('shared.example', SHARED, context).every(hint => hint.default === undefined)).toBe(true);
  });

  it('should decide the default over every sign-in, so "only" never says which accounts hold a password (L4)', () => {
    // Arrange — the card narrows to the accounts that can fill a password, which leaves one: "only"
    const fills = SHARED.signIns.filter(
      entry => SHARED.accounts.find(account => account.id === entry.account)?.fields.password,
    );
    const card = chosenSignIn('shared.example', fills);

    // Act
    const hints = accountHintsFor('shared.example', SHARED);

    // Assert — the hint does not narrow, so two match and neither is the default
    expect(card).toEqual({ signIn: SI(1), why: 'only' });
    expect(hints).toHaveLength(2);
    expect(hints.every(hint => hint.default === undefined)).toBe(true);
    expect(accountHintSummary('shared.example', hints)).not.toContain('Only account here');
  });

  it('should fence the recipe and name the method, the provider and the sign-in to propose against', () => {
    const summaryText = accountHintSummary('vercel.com', accountHintsFor('vercel.com', LIST));
    expect(summaryText).toContain(`[${SI(2)}]: Sign in with Google via 'Google (kirin)'`);
    expect(summaryText).toContain('for vercel.com');
    expect(summaryText).toContain('<<<recipe\nContinue with Google, then [[GOOGLE]].\nrecipe>>>');
    expect(summaryText).toContain('account_propose and the sign-in id');
    expect(summaryText).toContain('passkeys are off');
    expect(summaryText).toContain('Seen: vercel.com: password field (seen 3×, 2026-10-31).');
    expect(accountHintSummary('nothing.example', [])).toContain('No account for nothing.example');
  });
});

/**
 * Every property name a schema's JSON shape has, however deeply nested. `text`: only those that can hold free text
 * (a string that is not one of a fixed set), so an observed fact's yes-or-no `value` is not mistaken for a secret.
 */
function propertyNames(schema: z.ZodType, text = false): string[] {
  const names: string[] = [];
  const holdsText = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    const shape = node as Record<string, unknown>;
    if (shape.type === 'string') return shape.enum === undefined && shape.const === undefined;
    return [shape.anyOf, shape.oneOf, shape.allOf].some(options => Array.isArray(options) && options.some(holdsText));
  };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === 'object')
      names.push(
        ...Object.entries(properties as Record<string, unknown>)
          .filter(([, child]) => !text || holdsText(child))
          .map(([name]) => name),
      );
    for (const child of Object.values(record)) walk(child);
  };
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  return names;
}

describe('2FA keys as the owner reads them', () => {
  const record = TwoFactorKeyRecordSchema.parse(
    totpKey(TF(1), { seal: `${KEY(1)}_TOTP_00000001`, params: PARAMS, issuer: 'GitHub', accountName: 'kirinnee' }),
  );

  it('should drop the seal and say only whether Ferretry makes the codes', () => {
    // Act
    const summary = twoFactorKeySummaryOf(record);
    const typed = twoFactorKeySummaryOf(TwoFactorKeyRecordSchema.parse(totpKey(TF(2))));
    const sms = twoFactorKeySummaryOf(
      TwoFactorKeyRecordSchema.parse(otherKey(TF(3), 'sms', 'Phone', { endsWith: '42' })),
    );

    // Assert
    expect(summary).toEqual({
      id: TF(1),
      kind: 'totp',
      label: 'Authenticator app',
      addedAt: AT,
      addedBy: 'owner',
      params: PARAMS,
      issuer: 'GitHub',
      accountName: 'kirinnee',
      automatic: true,
    });
    expect(JSON.stringify(summary)).not.toContain('_TOTP_');
    expect(typed.automatic).toBe(false);
    expect(sms).toEqual({
      id: TF(3),
      kind: 'sms',
      label: 'Phone',
      addedAt: AT,
      addedBy: 'owner',
      endsWith: '42',
      automatic: false,
    });
    for (const parsed of [summary, typed, sms]) expect(TwoFactorKeySummarySchema.safeParse(parsed).success).toBe(true);
  });

  it('should refuse a summary that carries a seal, or says automatic of a key that cannot be', () => {
    for (const bad of [
      { ...twoFactorKeySummaryOf(record), seal: `${KEY(1)}_TOTP_00000001` },
      { ...twoFactorKeySummaryOf(record), automatic: false },
      { ...otherKey(TF(3), 'sms', 'Phone'), automatic: true },
      { ...otherKey(TF(3), 'push', 'Okta'), automatic: false, addedAt: 'yesterday' },
    ])
      expect(TwoFactorKeySummarySchema.safeParse(bad).success).toBe(false);
  });

  it('should keep the owner view’s compatibility fields in step with its keys', () => {
    // Arrange
    const owner = (fields: { password: boolean; totp: boolean }, factors: object[]) => ({
      id: 'GITHUB',
      label: 'GitHub',
      fields,
      factors,
      signIns: [],
      createdAt: AT,
      updatedAt: AT,
    });
    const automatic = twoFactorKeySummaryOf(record);

    // Act / Assert
    expect(AccountSummarySchema.safeParse(owner({ password: true, totp: true }, [automatic])).success).toBe(true);
    expect(AccountSummarySchema.safeParse(owner({ password: true, totp: false }, [automatic])).success).toBe(false);
    expect(AccountSummarySchema.safeParse(owner({ password: true, totp: true }, [])).success).toBe(false);
    expect(accountSeedFields([automatic])).toEqual({ totp: true, params: PARAMS });
    expect(accountSeedFields([twoFactorKeySummaryOf(TwoFactorKeyRecordSchema.parse(totpKey(TF(2))))])).toEqual({
      totp: false,
    });
  });

  it('should offer the automatic keys that worked first, then the untried, then the failed, newest first in each', () => {
    // Arrange
    const key = (n: number, addedAt: string, worked?: boolean) =>
      TwoFactorKeySummarySchema.parse({
        ...totpKey(TF(n), { label: `App ${String(n)}`, addedAt }),
        params: PARAMS,
        automatic: true,
        ...(worked === undefined ? {} : { verified: { worked, at: AT } }),
      });
    const keys = [
      key(1, '2026-10-01T00:00:00.000Z', false),
      key(2, '2026-10-02T00:00:00.000Z'),
      key(3, '2026-10-03T00:00:00.000Z', true),
      key(4, '2026-10-04T00:00:00.000Z'),
      key(5, '2026-10-05T00:00:00.000Z', true),
      TwoFactorKeySummarySchema.parse({ ...otherKey(TF(6), 'sms', 'Phone'), automatic: false }),
      TwoFactorKeySummarySchema.parse({ ...totpKey(TF(7), { label: 'Typed' }), automatic: false }),
    ];

    // Act
    const order = automaticKeysInOfferOrder(keys).map(each => each.id);

    // Assert
    expect(order).toEqual([TF(5), TF(3), TF(4), TF(2), TF(1)]);
  });

  it('should bind an add-2fa-key proof to one account and one staged seed', () => {
    // Arrange
    const stage = `st_${'a'.repeat(24)}`;
    const expected = createHash('sha256')
      .update(`ferretry.add-2fa-key.v1\0${KEY(1)}\0${stage}`)
      .digest('hex');

    // Act / Assert
    expect(addTwoFactorKeySubject(KEY(1), stage)).toBe(expected);
    expect(addTwoFactorKeySubject(KEY(2), stage)).not.toBe(expected);
    expect(addTwoFactorKeySubject(KEY(1), `st_${'b'.repeat(24)}`)).not.toBe(expected);
    expect(TwoFactorStageIdSchema.safeParse(stage).success).toBe(true);
    for (const bad of ['st_short', `st_${'A'.repeat(24)}`, `tf_${'a'.repeat(24)}`])
      expect(TwoFactorStageIdSchema.safeParse(bad).success).toBe(false);
  });

  it('should list every sealed name an account points at: the password and each key’s seed', () => {
    const parsed = AccountIndexDocumentSchema.parse(
      index(
        {
          A: account(1, {
            seals: { password: `${KEY(1)}_PASSWORD_00000001` },
            factors: [
              record,
              totpKey(TF(2), { label: 'Typed' }),
              otherKey(TF(3), 'sms', 'Phone'),
              totpKey(TF(4), { label: 'Backup', seal: `${KEY(1)}_TOTP_00000002`, params: PARAMS }),
            ],
          }),
        },
        {},
      ),
    );
    expect(sealedNamesOf(parsed.accounts.A ?? { seals: {} })).toEqual([
      `${KEY(1)}_PASSWORD_00000001`,
      `${KEY(1)}_TOTP_00000001`,
      `${KEY(1)}_TOTP_00000002`,
    ]);
  });

  it('should list, and check, every field of an account that holds a seal: one walk cannot miss what the other sees (L5)', () => {
    // Arrange — an account with every kind of key and every field filled, its seals found by shape, not by name
    const full = account(1, {
      username: 'kirin',
      seals: { password: `${KEY(1)}_PASSWORD_00000001` },
      factors: [
        totpKey(TF(1), {
          label: 'App',
          seal: `${KEY(1)}_TOTP_00000001`,
          params: PARAMS,
          issuer: 'GitHub',
          accountName: 'kirin',
          verified: { worked: true, at: AT },
        }),
        totpKey(TF(2), { label: 'Backup', seal: `${KEY(1)}_TOTP_00000002`, params: PARAMS }),
        totpKey(TF(3), { label: 'Typed' }),
        otherKey(TF(4), 'sms', 'Phone', { endsWith: '42' }),
        otherKey(TF(5), 'email', 'Inbox', { to: 'kirin@example.com' }),
        otherKey(TF(6), 'push', 'Okta', { app: 'okta-verify' }),
        otherKey(TF(7), 'security-key', 'YubiKey'),
      ],
      apartFrom: [KEY(2)],
    });
    const parsed = AccountIndexDocumentSchema.parse(index({ A: full, B: account(2) }, {}));
    const sealShaped: { path: (string | number)[]; seal: string }[] = [];
    const walk = (node: unknown, path: (string | number)[]): void => {
      if (typeof node === 'string' && SealedNameSchema.safeParse(node).success) sealShaped.push({ path, seal: node });
      else if (node !== null && typeof node === 'object')
        for (const [key, child] of Object.entries(node))
          walk(child, [...path, Array.isArray(node) ? Number(key) : key]);
    };
    walk(parsed.accounts.A, []);

    // Act / Assert — the sweep's list is exactly the seals there are
    expect(sealedNamesOf(parsed.accounts.A ?? { seals: {} }).toSorted()).toEqual(
      sealShaped.map(({ seal }) => seal).toSorted(),
    );
    expect(sealShaped).toHaveLength(3);
    // ...and each of them is checked: pointed at another account's secret, the index is damaged
    for (const { path, seal } of sealShaped) {
      const moved = structuredClone(full) as Record<string, unknown>;
      let at: Record<string | number, unknown> = moved;
      for (const step of path.slice(0, -1)) at = at[step] as Record<string | number, unknown>;
      at[path.at(-1) as string | number] = seal.replace(KEY(1), KEY(2));
      expect(AccountIndexDocumentSchema.safeParse(index({ A: moved, B: account(2) }, {})).success).toBe(false);
    }
  });
});

describe('the account wire shapes (invariant 1, the protocol half)', () => {
  it('should have no field named or shaped like a value', () => {
    const VALUE_LIKE =
      /^(value|values|password|passphrase|seed|secret|code|otp|token|plaintext|padded|digest|cipher)$/iu;
    for (const schema of [
      AccountSummarySchema,
      SignInSummarySchema,
      AccountListSchema,
      AccountHintSchema,
      AccountHintListSchema,
      TwoFactorKeySummarySchema,
      TwoFactorKeyHintSchema,
    ])
      expect(propertyNames(schema, true).filter(name => VALUE_LIKE.test(name))).toEqual([]);
    // `fields.password` on the owner's summary says only whether one exists.
    expect(AccountSummarySchema.shape.fields.shape.password).toBeInstanceOf(z.ZodBoolean);
    expect(propertyNames(AccountHintSchema)).not.toContain('password');
  });
});

describe('config/account-defaults.yaml', () => {
  it('should accept the owner’s sites, projects and folders', () => {
    const file = {
      sites: { 'app.clickup.com': 'CLICKUP_A', 'sudo@kirin-box': 'KIRIN' },
      projects: { ferretry: { 'app.clickup.com': 'CLICKUP_B' } },
      folders: {
        '~/Workspace/personal/scratch': { 'github.com': 'GITHUB_WORK' },
        '/srv/app': { 'github.com': 'GITHUB_WORK' },
      },
    };
    expect(AccountDefaultsFileSchema.safeParse(file).success).toBe(true);
    expect(AccountDefaultsFileSchema.safeParse({}).success).toBe(true);
  });

  it('should refuse an unknown key, a bad host, a bad handle, a relative folder and a padded project name', () => {
    for (const file of [
      { site: {} },
      { sites: { 'App.ClickUp.com': 'CLICKUP_A' } },
      { sites: { 'app.clickup.com': 'clickup_a' } },
      { folders: { 'Workspace/scratch': { 'github.com': 'GITHUB' } } },
      { folders: { '~/Workspace/../secrets': { 'github.com': 'GITHUB' } } },
      { folders: { '/srv/./app': { 'github.com': 'GITHUB' } } },
      { projects: { ' ferretry': { 'github.com': 'GITHUB' } } },
    ])
      expect(AccountDefaultsFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('account.propose', () => {
  it('should be keyed by the sign-in, never by a login handle', () => {
    const call = { tool: 'account.propose', signIn: SI(1), recipe: 'Open the page.', why: 'the steps were missing' };
    expect(AccountProposeCallSchema.safeParse(call).success).toBe(true);
    expect(AccountProposeCallSchema.safeParse({ ...call, signIn: 'GITHUB' }).success).toBe(false);
    expect(AccountProposeCallSchema.safeParse({ ...call, login: 'GITHUB' }).success).toBe(false);
  });
});
