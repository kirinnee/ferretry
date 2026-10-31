import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
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
const index = (accounts: Record<string, object>, signIns: Record<string, object>) => ({ v: 2, accounts, signIns });

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
    signInSummary(3, 'VERCEL_WORK', site(['vercel.com'])),
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
    const withSecrets = AccountListSchema.parse({
      ...LIST,
      accounts: LIST.accounts.map(account =>
        account.id === 'VERCEL_WORK'
          ? { ...account, fields: { password: true, totp: true }, totp: { algorithm: 'SHA1', digits: 6, period: 30 } }
          : account,
      ),
    });
    const withNothing = AccountListSchema.parse({
      ...LIST,
      accounts: LIST.accounts.map(account =>
        account.id === 'VERCEL_WORK' ? { ...account, fields: { password: false, totp: false } } : account,
      ),
    });

    // Act
    const one = accountHintsFor('vercel.com', withSecrets);
    const other = accountHintsFor('vercel.com', withNothing);

    // Assert
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
    expect(accountHintSummary('vercel.com', one)).toBe(accountHintSummary('vercel.com', other));
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
    const signIns = LIST.signIns.map(entry => ({ id: entry.id, account: entry.account, place: entry.place }));
    const choice = chosenSignIn('vercel.com', signIns, { defaults: { sites: { 'vercel.com': 'VERCEL_WORK' } } });

    // Act
    const hints = accountHintsFor('vercel.com', LIST, choice);

    // Assert
    expect(hints.find(hint => hint.signIn === SI(3))?.default).toEqual({ by: 'site' });
    expect(hints.filter(hint => hint.default !== undefined)).toHaveLength(1);
    expect(accountHintSummary('vercel.com', hints)).toContain(
      `'Vercel (work)' (VERCEL_WORK) as kirin@example.com [${SI(3)}]: password on vercel.com. Default for vercel.com.`,
    );
  });

  it('should never turn a ferret’s pick into a hint default', () => {
    const signIns = LIST.signIns.map(entry => ({ id: entry.id, account: entry.account, place: entry.place }));
    const choice = chosenSignIn('vercel.com', signIns, { hint: 'VERCEL_WORK' });
    expect(accountHintsFor('vercel.com', LIST, choice).every(hint => hint.default === undefined)).toBe(true);
  });

  it('should fence the recipe and name the method, the provider and the sign-in to propose against', () => {
    const summaryText = accountHintSummary('vercel.com', accountHintsFor('vercel.com', LIST));
    expect(summaryText).toContain(`[${SI(2)}]: Sign in with Google via 'Google (kirin)'`);
    expect(summaryText).toContain('for vercel.com');
    expect(summaryText).toContain('<<<recipe\nContinue with Google, then [[GOOGLE]].\nrecipe>>>');
    expect(summaryText).toContain('account_propose and the sign-in id');
    expect(summaryText).toContain('passkeys are off');
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
