import { describe, it } from 'bun:test';
import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  factorFingerprint,
  type InputRequestField,
  type InputTargetFacts,
  type SignInId,
  type SignInRuleId,
  type SignInSummary,
} from '@ferretry/protocol';
import should from 'should';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';
import {
  type GrantSighting,
  matchSignInGrant,
  NO_SCRIPTED_ORIGINS,
  type SignInGrant,
} from '../../../src/lib/sign-in-grants/matcher.ts';

/**
 * THE SHARED MATCHER, one row per check (docs/input-requests.md, "Task plan fills", "Standing rule fills"): each row's
 * facts fail exactly that check, and the miss names it. Pure, so every row is just facts in, a reason out. The table runs
 * for BOTH sources, a plan line and a standing rule (R3c invariant 11): every check a plan line passes, a rule passes
 * too; the rule's own rows (1b, 2b, 8, 15b, 17) follow.
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

/** A standing rule for the same sign-in, approved an hour ago with the owner's history of this very form, for any ferret. */
const RULE = 'sr_0123456789abcdef01234567' as SignInRuleId;
const ruleGrant = (over: Partial<SignInGrant> = {}): SignInGrant => {
  const { sessionId: _plansOnly, plan: _plan, ...base } = grant();
  return {
    ...base,
    id: `rule:${RULE}:1`,
    source: 'rule',
    rule: { id: RULE, revision: 1 },
    scope: { kind: 'any' },
    accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint([]) },
    approvedAt: NOW - 3_600_000,
    pins: {
      placeKeys: ['github.com'],
      recipeVersion: undefined,
      identities: [identityOf(page(), 'github.com') as string],
    },
    remaining: Number.POSITIVE_INFINITY,
    ...over,
  };
};

function sighting(over: Partial<GrantSighting> = {}, listing?: Partial<GrantSighting['listing']>): GrantSighting {
  const facts = over.facts ?? page();
  return {
    sessionId: SESSION,
    facts,
    matchKey:
      'matchKey' in over ? over.matchKey : facts.kind === 'browser' ? new URL(facts.origin).host : 'sudo@kirin-box',
    fields: LOGIN_FIELDS,
    listing: { accounts: [account()], signIns: [site()], ...listing },
    keys: new Map([['GITHUB' as AccountId, KEY]]),
    scripted: false,
    scriptedOrigins: NO_SCRIPTED_ORIGINS,
    now: NOW,
    ...over,
  };
}

const reasonOf = (theGrant: SignInGrant, seen: GrantSighting, pinned = new Map<string, string>()): string => {
  const match = matchSignInGrant(theGrant, seen, pinned);
  return match.ok ? 'filled' : match.reason;
};

describe('matchSignInGrant: a grant that covers the card fills it', () => {
  it('should leave uses to the ledger: a line whose uses are spent still matches, so a later step can join its attempt', () => {
    should(reasonOf(grant({ state: 'used-up', remaining: 0 }), sighting())).equal('filled');
  });

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
    /** What a standing rule says instead, when it differs (a rule for any ferret has no session; it is suspended, not stopped). */
    readonly rule?: string;
  }[] = [
    { check: '1 expired', grant: { expiresAt: NOW }, reason: 'expired' },
    {
      check: '1 another session',
      seen: { sessionId: 'mvv6b4qw-49d0158e' },
      reason: 'other-session',
      rule: 'filled',
    },
    { check: '1 a sub-ferret', seen: { sessionId: `${SESSION}-child` }, reason: 'other-session', rule: 'filled' },
    { check: '1 stopped', grant: { state: 'stopped' }, reason: 'stopped', rule: 'suspended' },
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
      // A rule pinned the username it was approved with: a username gone is the account changed.
      rule: 'account-changed',
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
      check: '10 an origin that does not parse',
      seen: {
        facts: page({ origin: 'not a url' }, [
          pageField('user', { frameOrigin: 'not a url' }),
          pageField('pass', { frameOrigin: 'not a url' }),
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

  for (const row of rows) {
    it(`check ${row.check}: ${row.reason} (a plan line)`, () => {
      should(reasonOf(grant(row.grant), sighting(row.seen, row.listing))).equal(row.reason);
    });
    it(`check ${row.check}: ${row.rule ?? row.reason} (a standing rule)`, () => {
      should(reasonOf(ruleGrant(row.grant), sighting(row.seen, row.listing))).equal(row.rule ?? row.reason);
    });
  }

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

// Run for both sources (R3c-T, invariant 24): a terminal rule passes exactly the rows a terminal plan line does.
for (const source of ['plan', 'rule'] as const)
  describe(`matchSignInGrant: terminal ${source === 'plan' ? 'lines' : 'rules'} are sudo, su or doas running setuid root`, () => {
    const sudoGrant = (): SignInGrant =>
      (source === 'plan' ? grant : ruleGrant)({
        surface: 'terminal',
        fields: new Set(['password']),
        pins: {
          placeKeys: ['sudo@kirin-box'],
          recipeVersion: undefined,
          // A rule pins the prompt the owner's own taps went into; a plan line pins its first fill.
          identities: source === 'plan' ? undefined : [identityOf(terminal(), 'sudo@kirin-box') as string],
        },
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

    it('should not fill su or doas at a grant pinned to sudo, nor another machine’s sudo', () => {
      should(reasonOf(sudoGrant(), sudoSeen(terminal({ program: 'su' }), 'su@kirin-box'))).equal('not-here');
      should(reasonOf(sudoGrant(), sudoSeen(terminal(), 'sudo@other-box'))).equal('not-here');
      // An unproved program has no key at all.
      should(
        reasonOf(
          sudoGrant(),
          sighting(
            {
              facts: terminal({ program: undefined }),
              matchKey: undefined,
              fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
            },
            sudoListing,
          ),
        ),
      ).equal('not-here');
    });

    it('should not type a username or a code into sudo, even under a grant that names them', () => {
      const wide = { ...sudoGrant(), fields: new Set(['username', 'password'] as const) } as SignInGrant;
      const seen = sighting(
        {
          facts: terminal(),
          matchKey: 'sudo@kirin-box',
          fields: [{ id: 'value', label: 'Username', sensitivity: 'plain' }],
        },
        sudoListing,
      );
      should(reasonOf(wide, seen)).equal('field-not-covered');
    });

    if (source === 'rule')
      it('should never pin a new prompt: one the owner’s taps never went into is a changed form, none at all no history', () => {
        const elsewhere = sudoSeen(terminal({ foreground: { pid: 11, pgid: 11, comm: 'sudo-rs', argv: 'sudo -v' } }));
        should(reasonOf(sudoGrant(), elsewhere)).equal('form-changed');
        const untapped = { ...sudoGrant(), pins: { ...sudoGrant().pins, identities: [] } };
        should(reasonOf(untapped, sudoSeen(terminal()))).equal('no-history');
      });
  });

describe('matchSignInGrant: a standing rule’s own checks (R3c-4)', () => {
  const PROJECT = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e01';
  const OTHER_PROJECT = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e02';
  const key = (id: string, addedAt: string, verified?: boolean) =>
    ({
      id,
      kind: 'totp' as const,
      label: id,
      automatic: true,
      addedAt,
      addedBy: 'owner' as const,
      ...(verified === undefined ? {} : { verified: { worked: verified, at: AT } }),
    }) as AccountSummary['factors'][number];
  const codePage = page({}, [pageField('otp', {}, { type: 'text', autocomplete: 'one-time-code' })]);
  const CODE_FIELDS: InputRequestField[] = [{ id: 'otp', label: 'Code', sensitivity: 'code' }];

  it('1b: a rule for any ferret fills in every session, and its sub-ferrets', () => {
    for (const sessionId of [SESSION, 'mvv6b4qw-49d0158e', `${SESSION}-child`])
      should(reasonOf(ruleGrant(), sighting({ sessionId }))).equal('filled');
  });

  it('1b: a rule for one session fills there only, never its children (and it is no suspension)', () => {
    const scoped = ruleGrant({ scope: { kind: 'session', session: SESSION } });
    should(reasonOf(scoped, sighting())).equal('filled');
    should(reasonOf(scoped, sighting({ sessionId: `${SESSION}-child` }))).equal('out-of-scope');
    should(reasonOf(scoped, sighting({ sessionId: 'mvv6b4qw-49d0158e' }))).equal('out-of-scope');
  });

  it('1b: a rule for one project fills only a session STAMPED with it; none stamped (folder-read, Unfiled) misses', () => {
    const scoped = ruleGrant({ scope: { kind: 'project', project: PROJECT } });
    should(reasonOf(scoped, sighting({ project: PROJECT }))).equal('filled');
    should(reasonOf(scoped, sighting({ project: OTHER_PROJECT }))).equal('out-of-scope');
    should(reasonOf(scoped, sighting())).equal('out-of-scope');
  });

  it('1b: a rule with no scope fills for nobody', () => {
    should(reasonOf(ruleGrant({ scope: undefined }), sighting())).equal('out-of-scope');
  });

  it('2b: a renamed account (same key, new handle) is the account changed', () => {
    const renamed = account({ id: 'GITHUB_WORK' as AccountId });
    const seen = sighting(
      { keys: new Map([['GITHUB_WORK' as AccountId, KEY]]) },
      { accounts: [renamed], signIns: [site({ account: 'GITHUB_WORK' as AccountId })] },
    );
    should(reasonOf(ruleGrant(), seen)).equal('account-changed');
    // A plan line pins only the key: the rename is no change to it.
    should(reasonOf(grant(), seen)).equal('filled');
  });

  it('2b: a new username is the account changed; a rule with no account pins fills nothing', () => {
    should(reasonOf(ruleGrant(), sighting({}, { accounts: [account({ username: 'someone-else' })] }))).equal(
      'account-changed',
    );
    should(reasonOf(ruleGrant({ accountPins: undefined }), sighting())).equal('account-changed');
  });

  it('8: any change to the account’s 2FA keys is the factors changed, even for a rule that types no code', () => {
    const added = sighting({}, { accounts: [account({ factors: [key('tf_0123456789abcdef01234567', AT)] })] });
    should(reasonOf(ruleGrant(), added)).equal('factor-changed');
    should(reasonOf(grant(), added)).equal('filled');
  });

  it('8: the code comes from the PINNED key, never the first key by `verified` order (secrev-1241 I1)', () => {
    const pinned = key('tf_00000000000b', '2026-09-01T00:00:00.000Z', false);
    const steered = key('tf_00000000000a', '2026-08-01T00:00:00.000Z', true);
    const factors = [steered, pinned];
    const codeIdentity = identityOf(codePage, 'github.com') as string;
    const rule = ruleGrant({
      fields: new Set(['username', 'password', 'totp']),
      factor: pinned.id,
      accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint(factors) },
      pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: [codeIdentity] },
    });
    const seen = sighting(
      { facts: codePage, fields: CODE_FIELDS },
      { accounts: [account({ fields: { password: true, totp: true }, factors })] },
    );
    should(matchSignInGrant(rule, seen, new Map())).match({ ok: true, fills: ['totp'], factor: pinned.id });
    // A plan line still takes the first key in offer order: the steered one.
    should(matchSignInGrant(grant({ fields: rule.fields }), seen, new Map())).match({ ok: true, factor: steered.id });
  });

  it('8: a pinned key that is gone or no longer automatic, or a code tick with no pinned key, makes no code', () => {
    const pinned = key('tf_00000000000b', AT);
    const manual = { ...pinned, automatic: false } as AccountSummary['factors'][number];
    const codeIdentity = identityOf(codePage, 'github.com') as string;
    const ruleWith = (factors: AccountSummary['factors'], factor?: string) =>
      ruleGrant({
        fields: new Set(['username', 'password', 'totp']),
        ...(factor === undefined ? {} : { factor: factor as SignInGrant['factor'] }),
        accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint(factors) },
        pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: [codeIdentity] },
      });
    const seenWith = (factors: AccountSummary['factors']) =>
      sighting({ facts: codePage, fields: CODE_FIELDS }, { accounts: [account({ factors })] });
    should(reasonOf(ruleWith([manual], pinned.id), seenWith([manual]))).equal('factor-changed');
    should(reasonOf(ruleWith([pinned]), seenWith([pinned]))).equal('factor-changed');
  });

  it('15b: a page script on one of its login domains since it was approved, in ANY session, stops it', () => {
    const at = (hosts: [string, number][], everywhere?: number): Partial<GrantSighting> => ({
      scriptedOrigins: { hosts: new Map(hosts), ...(everywhere === undefined ? {} : { everywhere }) },
    });
    should(reasonOf(ruleGrant(), sighting(at([['github.com', NOW - 60_000]])))).equal('scripted-origin');
    should(reasonOf(ruleGrant(), sighting(at([], NOW - 60_000)))).equal('scripted-origin');
    const twoPlaces = ruleGrant({
      pins: {
        placeKeys: ['github.com', 'login.github.com'],
        recipeVersion: undefined,
        identities: ruleGrant().pins.identities,
      },
    });
    const listing = {
      signIns: [site({ place: { kind: 'site', domains: ['github.com', 'login.github.com'], match: [] } })],
    };
    should(reasonOf(twoPlaces, sighting(at([['login.github.com', NOW - 1]]), listing))).equal('scripted-origin');
    // Before the owner approved it (they approved it knowing), or on another site: it fills.
    should(reasonOf(ruleGrant(), sighting(at([['github.com', NOW - 7_200_000]])))).equal('filled');
    should(reasonOf(ruleGrant(), sighting(at([['gitlab.com', NOW - 1]])))).equal('filled');
    // A plan line reads the session's own taint (15), not the machine's.
    should(reasonOf(grant(), sighting(at([['github.com', NOW - 1]])))).equal('filled');
  });

  it('17: a rule never pins a new form — no history at all, or a form outside it, never fills', () => {
    should(
      reasonOf(
        ruleGrant({ pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: undefined } }),
        sighting(),
      ),
    ).equal('no-history');
    should(
      reasonOf(
        ruleGrant({ pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: [] } }),
        sighting(),
      ),
    ).equal('no-history');
    // The same new password form a plan line would pin on its first fill: a rule calls it a changed form.
    const renamed = page({}, [pageField('user'), pageField('pass', {}, { name: 'pwd' })]);
    should(reasonOf(ruleGrant(), sighting({ facts: renamed }), new Map())).equal('form-changed');
    should(reasonOf(grant(), sighting({ facts: renamed }), new Map())).equal('filled');
  });

  it('17: a username-only step outside the history asks, and is no suspension; a lone code box may only join', () => {
    const userOnly = page({}, [pageField('user')]);
    should(
      reasonOf(
        ruleGrant(),
        sighting({ facts: userOnly, fields: [{ id: 'user', label: 'Username', sensitivity: 'plain' }] }),
      ),
    ).equal('no-history');
    const withCode = ruleGrant({
      fields: new Set(['username', 'password', 'totp']),
      factor: 'tf_00000000000b' as SignInGrant['factor'],
    });
    const factors = [key('tf_00000000000b', AT)];
    const codeRule = {
      ...withCode,
      accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint(factors) },
    };
    // One code box outside the history: a match the ledger lets through ONLY as a join to this rule's password attempt,
    // and one that pins nothing.
    const codeSeen = sighting({ facts: codePage, fields: CODE_FIELDS }, { accounts: [account({ factors })] });
    should(matchSignInGrant(codeRule, codeSeen, new Map())).match({ ok: true, fills: ['totp'], joinOnly: true });
    // A code form pinned earlier does not turn a join into a changed form: the join neither reads nor writes a pin.
    should(matchSignInGrant(codeRule, codeSeen, new Map([['totp', '0000000000000000']]))).match({ ok: true });
    // A code box beside another field is no lone code step: it asks.
    const codeAndUser = page({}, [
      pageField('user'),
      pageField('otp', {}, { type: 'text', autocomplete: 'one-time-code' }),
    ]);
    should(
      reasonOf(
        codeRule,
        sighting(
          {
            facts: codeAndUser,
            fields: [{ id: 'user', label: 'Username', sensitivity: 'plain' }, ...CODE_FIELDS],
          },
          { accounts: [account({ factors })] },
        ),
      ),
    ).equal('no-history');
    // Without the rule's code tick it never gets that far, and a page script on the place still comes first.
    should(reasonOf({ ...codeRule, fields: new Set(['username', 'password']) }, codeSeen)).equal('code-not-ticked');
    should(reasonOf(codeRule, { ...codeSeen, scriptedOrigins: { hosts: new Map([['github.com', NOW - 1]]) } })).equal(
      'scripted-origin',
    );
  });

  it('17: a code form IN the history is an ordinary fill, pinned as usual', () => {
    const factors = [key('tf_00000000000b', AT)];
    const codeRule = ruleGrant({
      fields: new Set(['username', 'password', 'totp']),
      factor: 'tf_00000000000b' as SignInGrant['factor'],
      accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint(factors) },
      pins: {
        placeKeys: ['github.com'],
        recipeVersion: undefined,
        identities: [identityOf(codePage, 'github.com') as string],
      },
    });
    const match = matchSignInGrant(
      codeRule,
      sighting({ facts: codePage, fields: CODE_FIELDS }, { accounts: [account({ factors })] }),
      new Map(),
    );
    should(match).match({ ok: true, fills: ['totp'] });
    should(match.ok && match.joinOnly).not.be.ok();
  });
});
