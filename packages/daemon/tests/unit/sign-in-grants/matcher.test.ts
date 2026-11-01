import { describe, it } from 'bun:test';
import type {
  AccountId,
  AccountKey,
  AccountSummary,
  InputRequestField,
  InputTargetFacts,
  SignInId,
  SignInSummary,
} from '@ferretry/protocol';
import should from 'should';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';
import { type GrantSighting, matchSignInGrant, type SignInGrant } from '../../../src/lib/sign-in-grants/matcher.ts';

/**
 * THE SHARED MATCHER, one row per check (docs/input-requests.md, "Task plan fills"): each row's facts fail exactly that
 * check, and the miss names it. Pure, so every row is just facts in, a reason out.
 */

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 'mvv6b4qw-49d0158d';
const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
const OTHER_SIGN_IN = 'si_fedcba9876543210fedcba98' as SignInId;
const KEY = `L${'a'.repeat(31)}` as AccountKey;
const AT = '2026-10-01T00:00:00.000Z';

type PageFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;
type PageField = PageFacts['fields'][number];
type TerminalFacts = Extract<InputTargetFacts, { readonly kind: 'terminal' }>;

const pageField = (
  fieldId: string,
  over: Partial<PageField> = {},
  attrs: Partial<PageField['field']> = {},
): PageField => ({
  fieldId,
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId: fieldId === 'pass' ? 12 : 11,
  field: {
    tag: 'input',
    ...(fieldId === 'pass' ? { type: 'password', name: 'password' } : { type: 'text' }),
    ...attrs,
  },
  box: { x: 0, y: 0, w: 100, h: 30 },
  visible: true,
  ...over,
});

const page = (over: Partial<PageFacts> = {}, fields?: PageField[]): PageFacts => ({
  kind: 'browser',
  pageId: 'p1',
  origin: 'https://github.com',
  secure: true,
  navigationId: 'n1',
  fields: fields ?? [pageField('user'), pageField('pass')],
  ...over,
});

const terminal = (over: Partial<TerminalFacts> = {}): TerminalFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%1', pid: 10 },
  foreground: { pid: 11, pgid: 11, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 0,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'b'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
  trustedProgram: true,
  ...over,
});

const LOGIN_FIELDS: InputRequestField[] = [
  { id: 'user', label: 'Username', sensitivity: 'plain' },
  { id: 'pass', label: 'Password', sensitivity: 'secret' },
];

const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'GITHUB' as AccountId,
  label: 'GitHub',
  username: 'kirinnee',
  fields: { password: true, totp: false },
  factors: [],
  signIns: [SIGN_IN],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const site = (over: Partial<SignInSummary> = {}): SignInSummary => ({
  id: SIGN_IN,
  account: 'GITHUB' as AccountId,
  place: { kind: 'site', domains: ['github.com'], match: ['github.com', 'gist.github.com'] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const grant = (over: Partial<SignInGrant> = {}): SignInGrant => ({
  id: `plan:${'ab'.repeat(16)}:0`,
  source: 'plan',
  plan: { id: 'ab'.repeat(16), line: 0 },
  sessionId: SESSION,
  surface: 'page',
  signIn: SIGN_IN,
  accountKey: KEY,
  fields: new Set(['username', 'password']),
  pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: undefined },
  expiresAt: NOW + 3_600_000,
  state: 'in-force',
  remaining: 1,
  ...over,
});

function sighting(over: Partial<GrantSighting> = {}, listing?: Partial<GrantSighting['listing']>): GrantSighting {
  const facts = over.facts ?? page();
  return {
    sessionId: SESSION,
    facts,
    matchKey: facts.kind === 'browser' ? new URL(facts.origin).host : 'sudo@kirin-box',
    fields: LOGIN_FIELDS,
    listing: { accounts: [account()], signIns: [site()], ...listing },
    keys: new Map([['GITHUB' as AccountId, KEY]]),
    scripted: false,
    now: NOW,
    ...over,
  };
}

const reasonOf = (theGrant: SignInGrant, seen: GrantSighting, pinned = new Map<string, string>()): string => {
  const match = matchSignInGrant(theGrant, seen, pinned);
  return match.ok ? 'filled' : match.reason;
};

describe('matchSignInGrant: a grant that covers the card fills it', () => {
  it('should fill a login card at the pinned login domain, with the roles in the card’s order', () => {
    const match = matchSignInGrant(grant(), sighting(), new Map());
    should(match).match({
      ok: true,
      account: 'GITHUB',
      fills: ['username', 'password'],
      fieldSet: 'password+username',
    });
  });
});

describe('matchSignInGrant: every check holds or nothing is typed (one row per check)', () => {
  const rows: readonly {
    readonly check: string;
    readonly grant?: Partial<SignInGrant>;
    readonly seen?: Partial<GrantSighting>;
    readonly listing?: Partial<GrantSighting['listing']>;
    readonly reason: string;
  }[] = [
    { check: '1 expired', grant: { expiresAt: NOW }, reason: 'expired' },
    { check: '1 another session', seen: { sessionId: 'mvv6b4qw-49d0158e' }, reason: 'other-session' },
    { check: '1 a sub-ferret', seen: { sessionId: `${SESSION}-child` }, reason: 'other-session' },
    { check: '1 stopped', grant: { state: 'stopped' }, reason: 'stopped' },
    { check: '1 used up', grant: { state: 'used-up', remaining: 0 }, reason: 'used-up' },
    { check: '2 the sign-in removed', listing: { signIns: [] }, reason: 'sign-in-gone' },
    {
      check: '2 the sign-in on another account',
      seen: { keys: new Map([['GITHUB' as AccountId, `L${'b'.repeat(31)}` as AccountKey]]) },
      reason: 'sign-in-gone',
    },
    {
      check: '2 now a provider sign-in',
      listing: {
        signIns: [
          site({
            via: { account: { id: 'GOOGLE' as AccountId, label: 'Google' }, signIn: OTHER_SIGN_IN },
          } as Partial<SignInSummary>),
        ],
      },
      reason: 'sign-in-gone',
    },
    {
      check: '3 a login domain added',
      listing: {
        signIns: [site({ place: { kind: 'site', domains: ['github.com', 'gh.example'], match: ['github.com'] } })],
      },
      reason: 'place-changed',
    },
    { check: '4 the recipe changed', listing: { signIns: [site({ recipeVersion: 2 })] }, reason: 'recipe-changed' },
    { check: '5 a look-alike host', seen: { matchKey: 'github.com.evil.example' }, reason: 'not-here' },
    {
      check: '5 a parent domain',
      grant: { pins: { placeKeys: ['login.github.com'], recipeVersion: undefined, identities: undefined } },
      listing: {
        signIns: [site({ place: { kind: 'site', domains: ['login.github.com'], match: ['login.github.com'] } })],
      },
      reason: 'not-here',
    },
    { check: '5 a match-only host', seen: { matchKey: 'gist.github.com' }, reason: 'not-here' },
    { check: '5 the wrong surface', seen: { facts: terminal(), matchKey: 'github.com' }, reason: 'not-here' },
    {
      check: '6 a private value',
      seen: { fields: [...LOGIN_FIELDS, { id: 'pin', label: 'PIN', sensitivity: 'private' }] },
      reason: 'field-not-covered',
    },
    {
      check: '6 a field the line did not ask for',
      grant: { fields: new Set(['password']) },
      reason: 'field-not-covered',
    },
    {
      check: '6 two passwords (a change-password form)',
      seen: {
        fields: [
          { id: 'pass', label: 'Password', sensitivity: 'secret' },
          { id: 'pass2', label: 'Again', sensitivity: 'secret' },
        ],
      },
      reason: 'field-not-covered',
    },
    {
      check: '6 a code with no code tick',
      seen: { fields: [{ id: 'otp', label: 'Code', sensitivity: 'code' }] },
      reason: 'code-not-ticked',
    },
    { check: '7 a hint naming another account', seen: { hint: 'GITLAB' }, reason: 'ferret-named-another' },
    { check: '7 a hint naming another sign-in', seen: { hint: OTHER_SIGN_IN }, reason: 'ferret-named-another' },
    {
      check: '8 no password saved',
      listing: { accounts: [account({ fields: { password: false, totp: false } })] },
      reason: 'account-lacks-field',
    },
    {
      check: '8 no username saved',
      listing: { accounts: [account({ username: undefined })] },
      reason: 'account-lacks-field',
    },
    {
      check: '10 http',
      seen: {
        facts: page({ origin: 'http://github.com', secure: false }, [
          pageField('user', { frameOrigin: 'http://github.com' }),
          pageField('pass', { frameOrigin: 'http://github.com' }),
        ]),
      },
      reason: 'not-https',
    },
    {
      check: '10 http://localhost (secure, not https)',
      seen: {
        facts: page({ origin: 'http://localhost:8080', secure: true }, [
          pageField('user', { frameOrigin: 'http://localhost:8080' }),
          pageField('pass', { frameOrigin: 'http://localhost:8080' }),
        ]),
        matchKey: 'github.com',
      },
      reason: 'not-https',
    },
    {
      check: '11 a cross-origin frame',
      seen: { facts: page({}, [pageField('user'), pageField('pass', { frameOrigin: 'https://evil.example' })]) },
      reason: 'frame',
    },
    {
      check: '12 a text-type password field',
      seen: { facts: page({}, [pageField('user'), pageField('pass', {}, { type: 'text' })]) },
      reason: 'password-field',
    },
    {
      check: '12 a hidden password field',
      seen: { facts: page({}, [pageField('user'), pageField('pass', { visible: false })]) },
      reason: 'password-field',
    },
    {
      check: '12 a covered password field',
      seen: { facts: page({}, [pageField('user'), pageField('pass', { covered: true })]) },
      reason: 'password-field',
    },
    { check: '12 a password field missing', seen: { facts: page({}, [pageField('user')]) }, reason: 'password-field' },
    {
      check: '13 a covered username field',
      seen: { facts: page({}, [pageField('user', { covered: true }), pageField('pass')]) },
      reason: 'field-hidden',
    },
    {
      check: '14 a human check',
      seen: { facts: page({ challenge: { provider: 'cloudflare' } }) },
      reason: 'challenge',
    },
    { check: '15 a page script earlier in the session', seen: { scripted: true }, reason: 'scripted' },
    {
      check: '17 a form without history',
      grant: { pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: ['0000000000000000'] } },
      reason: 'form-changed',
    },
  ];

  for (const row of rows)
    it(`check ${row.check}: ${row.reason}`, () => {
      should(reasonOf(grant(row.grant), sighting(row.seen, row.listing))).equal(row.reason);
    });

  it('checks 13–16 on a code card: it fills with the code tick, and an unseen code field or no automatic key misses', () => {
    const factor = {
      id: 'tf_0123456789abcdef01234567',
      kind: 'totp' as const,
      label: 'App',
      automatic: true,
      addedAt: AT,
      addedBy: 'owner' as const,
    };
    const seen = sighting(
      {
        facts: page({}, [
          pageField('otp', { frameOrigin: 'https://github.com' }, { type: 'text', autocomplete: 'one-time-code' }),
        ]),
        fields: [{ id: 'otp', label: 'Code', sensitivity: 'code' }],
      },
      {
        accounts: [account({ fields: { password: true, totp: true }, factors: [factor] as AccountSummary['factors'] })],
      },
    );
    const ticked = grant({ fields: new Set(['username', 'password', 'totp']) });
    should(matchSignInGrant(ticked, seen, new Map())).match({ ok: true, fills: ['totp'], factor: factor.id });
    should(reasonOf(ticked, { ...seen, facts: page({}, [pageField('otp', { visible: false })]) })).equal(
      'field-hidden',
    );
    const noKey = sighting({ facts: seen.facts, fields: seen.fields });
    should(reasonOf(ticked, noKey)).equal('account-lacks-field');
  });

  it('check 17: the first fill pins the form; a later one with another form misses, the same one fills', () => {
    const first = matchSignInGrant(grant(), sighting(), new Map());
    if (!first.ok) throw new Error('expected a fill');
    const pinned = new Map([[first.fieldSet, first.identity]]);
    should(reasonOf(grant(), sighting(), pinned)).equal('filled');
    const renamed = page({}, [pageField('user'), pageField('pass', {}, { name: 'pwd' })]);
    should(reasonOf(grant(), sighting({ facts: renamed }), pinned)).equal('form-changed');
  });

  it('check 17: with history, a password form must be one of them', () => {
    const identity = identityOf(page(), 'github.com') as string;
    const withHistory = grant({
      pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: [identity] },
    });
    should(reasonOf(withHistory, sighting())).equal('filled');
  });
});

describe('matchSignInGrant: the ferret’s words can only prevent', () => {
  it('should fill the same whether the hint names the grant’s account, its sign-in, or nothing', () => {
    should(reasonOf(grant(), sighting({ hint: 'GITHUB' }))).equal('filled');
    should(reasonOf(grant(), sighting({ hint: SIGN_IN }))).equal('filled');
    should(reasonOf(grant(), sighting())).equal('filled');
  });
});

describe('matchSignInGrant: terminal lines are sudo, su or doas running setuid root', () => {
  const sudoGrant = (): SignInGrant =>
    grant({
      surface: 'terminal',
      fields: new Set(['password']),
      pins: { placeKeys: ['sudo@kirin-box'], recipeVersion: undefined, identities: undefined },
    });
  const sudoListing = {
    signIns: [site({ place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } })],
  };
  const sudoSeen = (facts: TerminalFacts, matchKey = 'sudo@kirin-box'): GrantSighting =>
    sighting({ facts, matchKey, fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }] }, sudoListing);

  it('should fill a proved, setuid-root sudo prompt in line mode with echo off', () => {
    should(reasonOf(sudoGrant(), sudoSeen(terminal()))).equal('filled');
  });

  const rows: readonly { readonly name: string; readonly facts: TerminalFacts; readonly reason: string }[] = [
    {
      name: 'an unproved program (a shell renamed sudo)',
      facts: terminal({ program: undefined, trustedProgram: undefined }),
      reason: 'not-proved',
    },
    { name: 'echo on', facts: terminal({ echo: 'on' }), reason: 'not-proved' },
    { name: 'raw mode', facts: terminal({ canonical: false }), reason: 'not-proved' },
    { name: 'not a known secret reader', facts: terminal({ recognisedConsumer: false }), reason: 'not-proved' },
    { name: 'not setuid root', facts: terminal({ trustedProgram: undefined }), reason: 'not-system' },
    {
      name: 'passwd (a getpass program, not a plan tool)',
      facts: terminal({ program: 'passwd', foreground: { pid: 11, pgid: 11, comm: 'passwd', argv: 'passwd' } }),
      reason: 'not-system',
    },
  ];
  for (const row of rows)
    it(`should not fill ${row.name}: ${row.reason}`, () => {
      // The match key follows the PROVED program, so a renamed shell and passwd would not even be at sudo@kirin-box;
      // the row still proves the checks behind it on their own.
      should(reasonOf(sudoGrant(), sudoSeen(row.facts))).equal(row.reason);
    });
});
