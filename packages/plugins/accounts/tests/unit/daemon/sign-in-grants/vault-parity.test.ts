import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/core-vault/contract';
import should from 'should';
import {
  codeTargetProblem as vaultCodeTargetProblem,
  type SavedListing as VaultListing,
} from '../../../../../../core/vault/daemon/lib/inputs/saved-logins.ts';
import {
  matchSignInGrant as vaultMatchSignInGrant,
  type GrantSighting as VaultSighting,
  type SignInGrant as VaultGrant,
} from '../../../../../../core/vault/daemon/lib/inputs/borrowed-grants.ts';
import { identityOf as vaultIdentityOf } from '../../../../../../core/vault/daemon/lib/inputs/login-observer.ts';
import { terminalHides as vaultTerminalHides } from '../../../../../../core/vault/daemon/lib/inputs/lock.ts';
import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  factorFingerprint,
  type SignInId,
  type SignInRuleId,
  type SignInSummary,
} from '../../../../contract/routes/index.ts';
import {
  type GrantSighting,
  matchSignInGrant,
  NO_SCRIPTED_ORIGINS,
  type SignInGrant,
} from '../../../../daemon/lib/sign-in-grants/matcher.ts';
import {
  codeTargetProblem,
  identityOf,
  type InputRequestField,
  terminalHides,
} from '../../../../daemon/lib/vault-inputs.ts';

/**
 * appd-acc F4 (row 83): ONE RULE, TWO COPIES, KEPT EQUAL. Accounts' `vault-inputs.ts` (`codeTargetProblem`, `identityOf`,
 * `terminalHides`) and `sign-in-grants/matcher.ts` are byte copies of the Vault's `saved-logins.ts`, `login-observer.ts`,
 * `lock.ts` and `borrowed-grants.ts`: Accounts' plan and rule paths decide with the first, the Vault's tap and fill path
 * with the second, so a copy that drifts is a fill one half allows and the other half refuses. The rule is security
 * (where a one-time code or a saved password may be typed), so these tests run every case through BOTH copies and
 * require the same answer, instead of trusting a comment that says "copied". Test-only: neither copy is edited here.
 */

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 'mvv6b4qw-49d0158d';
const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
const OTHER_SIGN_IN = 'si_fedcba9876543210fedcba98' as SignInId;
const KEY = `L${'a'.repeat(31)}` as AccountKey;
const AT = '2026-10-01T00:00:00.000Z';
const RULE = 'sr_0123456789abcdef01234567' as SignInRuleId;

type PageFacts = Extract<InputTargetFacts, { readonly kind: 'page' }>;
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
  kind: 'page',
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

describe('appd-acc F4 codeTargetProblem: both copies give the same sentence for every shape of target', () => {
  const origins = ['https://github.com', 'http://github.com', 'https://evil.example'];
  const targets: { readonly name: string; readonly facts: InputTargetFacts | undefined }[] = [
    { name: 'no look at the target', facts: undefined },
    { name: 'a secret', facts: { kind: 'secret', name: 'X', exists: false } as InputTargetFacts },
    { name: 'a terminal', facts: terminal() },
    { name: 'an unproved terminal', facts: terminal({ program: undefined, trustedProgram: undefined }) },
  ];
  for (const secure of [true, false])
    for (const visible of [true, false])
      for (const covered of [undefined, true] as const)
        for (const frameOrigin of origins)
          for (const present of [true, false]) {
            const field = pageField('otp', { visible, frameOrigin, ...(covered === undefined ? {} : { covered }) });
            targets.push({
              name: `a page secure=${secure} visible=${visible} covered=${String(covered)} frame=${frameOrigin} field=${present}`,
              facts: page({ secure }, present ? [field] : []),
            });
          }

  it('appd-acc F4 should answer alike on every combination, and not vacuously (more than one distinct sentence)', () => {
    const answers = new Set<string | undefined>();
    for (const target of targets)
      for (const ids of [['otp'], ['otp', 'missing'], []]) {
        const ours = codeTargetProblem(target.facts, ids);
        const vault = vaultCodeTargetProblem(target.facts, ids);
        should({ target: target.name, ids, problem: ours }).eql({ target: target.name, ids, problem: vault });
        answers.add(ours);
      }
    should(answers.size).be.aboveOrEqual(5);
    should(answers.has(undefined)).be.true();
  });
});

describe('appd-acc F4 identityOf and terminalHides: both copies agree', () => {
  it('appd-acc F4 should compute the same form identity for pages and terminals, and none for a secret', () => {
    const cases: readonly InputTargetFacts[] = [
      page(),
      page({}, [pageField('user'), pageField('pass', {}, { name: 'pwd', autocomplete: 'current-password' })]),
      page({ origin: 'https://gist.github.com' }),
      terminal(),
      terminal({ foreground: { pid: 11, pgid: 11, comm: 'sudo-rs', argv: 'sudo -v' } }),
      { kind: 'secret', name: 'X', exists: true } as InputTargetFacts,
    ];
    for (const facts of cases) should(identityOf(facts, 'p@h')).equal(vaultIdentityOf(facts, 'p@h'));
    should(identityOf(page(), 'p@h')).be.a.String();
    should(identityOf(terminal(), 'p@h')).not.equal(identityOf(terminal(), 'q@h'));
  });

  it('appd-acc F4 should hide a terminal the same way for every program and flag', () => {
    const programs = ['sudo', 'sudoedit', 'su', 'doas', 'passwd', 'ssh', 'git', undefined];
    const seen = new Set<boolean>();
    for (const program of programs)
      for (const echo of ['off', 'on'] as const)
        for (const canonical of [true, false])
          for (const trustedProgram of [true, false, undefined]) {
            const facts = terminal({
              ...(program === undefined ? { program: undefined } : { program }),
              echo,
              canonical,
              trustedProgram,
            } as Partial<TerminalFacts>);
            should(terminalHides(facts)).equal(vaultTerminalHides(facts));
            seen.add(terminalHides(facts));
          }
    should([...seen].sort()).eql([false, true]);
    should(terminalHides(page())).equal(vaultTerminalHides(page()));
  });
});

// ─── the shared matcher ───

const LOGIN_FIELDS: InputRequestField[] = [
  { id: 'user', label: 'Username', sensitivity: 'plain' },
  { id: 'pass', label: 'Password', sensitivity: 'secret' },
];

const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'GITHUB' as AccountId,
  label: 'GitHub',
  username: 'kirinnee',
  fields: { password: true },
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

const totpKey = {
  id: 'tf_0123456789abcdef01234567',
  kind: 'totp' as const,
  label: 'App',
  automatic: true,
  addedAt: AT,
  addedBy: 'owner' as const,
};

const planGrant = (over: Partial<SignInGrant> = {}): SignInGrant => ({
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

const ruleGrant = (over: Partial<SignInGrant> = {}): SignInGrant => {
  const { sessionId: _plansOnly, plan: _plan, ...base } = planGrant();
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
      'matchKey' in over ? over.matchKey : facts.kind === 'page' ? new URL(facts.origin).host : 'sudo@kirin-box',
    fields: LOGIN_FIELDS,
    listing: { accounts: [account()], signIns: [site()], ...listing },
    keys: new Map([['GITHUB' as AccountId, KEY]]),
    scripted: false,
    scriptedOrigins: NO_SCRIPTED_ORIGINS,
    now: NOW,
    ...over,
  };
}

interface Row {
  readonly name: string;
  readonly grant?: Partial<SignInGrant>;
  readonly seen?: Partial<GrantSighting>;
  readonly listing?: Partial<GrantSighting['listing']>;
}

const CODE_FIELDS: InputRequestField[] = [{ id: 'otp', label: 'Code', sensitivity: 'code' }];
const codePage = page({}, [pageField('otp', {}, { type: 'text', autocomplete: 'one-time-code' })]);
const withKey = { accounts: [account({ factors: [totpKey] as AccountSummary['factors'] })] };
const tickedCode = { fields: new Set(['username', 'password', 'totp'] as const) } as Partial<SignInGrant>;
const sudoListing = { signIns: [site({ place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } })] };
const SUDO_FIELDS: InputRequestField[] = [{ id: 'value', label: 'Password', sensitivity: 'secret' }];
const sudoGrant = (over: Partial<SignInGrant> = {}): Partial<SignInGrant> => ({
  surface: 'terminal',
  fields: new Set(['password']),
  pins: {
    placeKeys: ['sudo@kirin-box'],
    recipeVersion: undefined,
    identities: [identityOf(terminal(), 'sudo@kirin-box') as string],
  },
  ...over,
});
const sudoSeen = (facts: TerminalFacts, matchKey = 'sudo@kirin-box'): Partial<GrantSighting> => ({
  facts,
  matchKey,
  fields: SUDO_FIELDS,
});

const ROWS: readonly Row[] = [
  { name: 'a card the grant covers' },
  { name: '1 expired', grant: { expiresAt: NOW } },
  { name: '1 another session', seen: { sessionId: 'mvv6b4qw-49d0158e' } },
  { name: '1 a sub-ferret', seen: { sessionId: `${SESSION}-child` } },
  { name: '1 stopped', grant: { state: 'stopped' } },
  { name: '1 used up', grant: { state: 'used-up', remaining: 0 } },
  { name: '2 the sign-in removed', listing: { signIns: [] } },
  {
    name: '2 another account key',
    seen: { keys: new Map([['GITHUB' as AccountId, `L${'b'.repeat(31)}` as AccountKey]]) },
  },
  {
    name: '2 now a provider sign-in',
    listing: {
      signIns: [
        site({
          via: { account: { id: 'GOOGLE' as AccountId, label: 'Google' }, signIn: OTHER_SIGN_IN },
        } as Partial<SignInSummary>),
      ],
    },
  },
  {
    name: '3 a login domain added',
    listing: {
      signIns: [site({ place: { kind: 'site', domains: ['github.com', 'gh.example'], match: ['github.com'] } })],
    },
  },
  { name: '4 the recipe changed', listing: { signIns: [site({ recipeVersion: 2 })] } },
  { name: '5 a look-alike host', seen: { matchKey: 'github.com.evil.example' } },
  { name: '5 a match-only host', seen: { matchKey: 'gist.github.com' } },
  { name: '5 no key', seen: { matchKey: undefined } },
  { name: '5 the wrong surface', seen: { facts: terminal(), matchKey: 'github.com' } },
  {
    name: '6 a private value',
    seen: { fields: [...LOGIN_FIELDS, { id: 'pin', label: 'PIN', sensitivity: 'private' }] },
  },
  { name: '6 a field the line did not ask for', grant: { fields: new Set(['password']) } },
  {
    name: '6 two passwords',
    seen: {
      fields: [
        { id: 'pass', label: 'Password', sensitivity: 'secret' },
        { id: 'pass2', label: 'Again', sensitivity: 'secret' },
      ],
    },
  },
  { name: '6 no fields', seen: { fields: [] } },
  { name: '6 a code with no code tick', seen: { fields: CODE_FIELDS, facts: codePage } },
  { name: '7 a hint naming another account', seen: { hint: 'GITLAB' } },
  { name: '7 a hint naming another sign-in', seen: { hint: OTHER_SIGN_IN } },
  { name: '7 a hint naming the account', seen: { hint: 'GITHUB' } },
  { name: '8 no password saved', listing: { accounts: [account({ fields: { password: false } })] } },
  { name: '8 no username saved', listing: { accounts: [account({ username: undefined })] } },
  {
    name: '8 a renamed account',
    listing: { accounts: [account({ username: 'someone-else' })] },
  },
  {
    name: '8 a new 2FA key',
    listing: { accounts: [account({ factors: [totpKey] as AccountSummary['factors'] })] },
  },
  {
    name: '10 http',
    seen: {
      facts: page({ origin: 'http://github.com', secure: false }, [
        pageField('user', { frameOrigin: 'http://github.com' }),
        pageField('pass', { frameOrigin: 'http://github.com' }),
      ]),
    },
  },
  {
    name: '10 an origin that does not parse',
    seen: {
      facts: page({ origin: 'not a url' }, [
        pageField('user', { frameOrigin: 'not a url' }),
        pageField('pass', { frameOrigin: 'not a url' }),
      ]),
      matchKey: 'github.com',
    },
  },
  {
    name: '11 a cross-origin frame',
    seen: { facts: page({}, [pageField('user'), pageField('pass', { frameOrigin: 'https://evil.example' })]) },
  },
  {
    name: '12 a text-type password field',
    seen: { facts: page({}, [pageField('user'), pageField('pass', {}, { type: 'text' })]) },
  },
  {
    name: '12 a hidden password field',
    seen: { facts: page({}, [pageField('user'), pageField('pass', { visible: false })]) },
  },
  {
    name: '12 a covered password field',
    seen: { facts: page({}, [pageField('user'), pageField('pass', { covered: true })]) },
  },
  { name: '12 a password field missing', seen: { facts: page({}, [pageField('user')]) } },
  {
    name: '13 a covered username field',
    seen: { facts: page({}, [pageField('user', { covered: true }), pageField('pass')]) },
  },
  { name: '14 a human check', seen: { facts: page({ challenge: { provider: 'cloudflare' } }) } },
  { name: '15 a page script earlier in the session', seen: { scripted: true } },
  {
    name: '15b a page script on its place since approval (any session)',
    seen: { scriptedOrigins: { hosts: new Map([['github.com', NOW - 60_000]]) } },
  },
  {
    name: '15b a page script on an unreadable page',
    seen: { scriptedOrigins: { hosts: new Map(), everywhere: NOW - 60_000 } },
  },
  {
    name: '15b a page script on another site',
    seen: { scriptedOrigins: { hosts: new Map([['elsewhere.example', NOW - 60_000]]) } },
  },
  {
    name: '17 a form without history',
    grant: { pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: ['0000000000000000'] } },
  },
  {
    name: '17 a renamed password box',
    seen: { facts: page({}, [pageField('user'), pageField('pass', {}, { name: 'pwd' })]) },
  },
  {
    name: '13 a code card with the code tick and a key',
    grant: tickedCode,
    seen: { facts: codePage, fields: CODE_FIELDS },
    listing: withKey,
  },
  {
    name: '13 a code card, field covered',
    grant: tickedCode,
    seen: { facts: page({}, [pageField('otp', { covered: true })]), fields: CODE_FIELDS },
    listing: withKey,
  },
  {
    name: '13 a code card, frame from another site',
    grant: tickedCode,
    seen: { facts: page({}, [pageField('otp', { frameOrigin: 'https://evil.example' })]), fields: CODE_FIELDS },
    listing: withKey,
  },
  {
    name: '13 a code card, no automatic key',
    grant: tickedCode,
    seen: { facts: codePage, fields: CODE_FIELDS },
  },
  {
    name: '13 a code card, key not the pinned one',
    grant: { ...tickedCode, factor: 'tf_ffffffffffffffffffffffff' as never },
    seen: { facts: codePage, fields: CODE_FIELDS },
    listing: withKey,
  },
  {
    name: '13 a code card, the pinned key is one Ferretry makes no codes for',
    grant: { ...tickedCode, factor: totpKey.id as never },
    seen: { facts: codePage, fields: CODE_FIELDS },
    listing: { accounts: [account({ factors: [{ ...totpKey, automatic: false }] as AccountSummary['factors'] })] },
  },
  {
    name: '13 a code card, pinned key',
    grant: { ...tickedCode, factor: totpKey.id as never },
    seen: { facts: codePage, fields: CODE_FIELDS },
    listing: withKey,
  },
  // Terminals (10t–13t).
  { name: 't a proved sudo prompt', grant: sudoGrant(), seen: sudoSeen(terminal()), listing: sudoListing },
  {
    name: 't an unproved program',
    grant: sudoGrant(),
    seen: sudoSeen(terminal({ program: undefined, trustedProgram: undefined })),
    listing: sudoListing,
  },
  { name: 't echo on', grant: sudoGrant(), seen: sudoSeen(terminal({ echo: 'on' })), listing: sudoListing },
  { name: 't raw mode', grant: sudoGrant(), seen: sudoSeen(terminal({ canonical: false })), listing: sudoListing },
  {
    name: 't not a known secret reader',
    grant: sudoGrant(),
    seen: sudoSeen(terminal({ recognisedConsumer: false })),
    listing: sudoListing,
  },
  {
    name: 't not setuid root',
    grant: sudoGrant(),
    seen: sudoSeen(terminal({ trustedProgram: undefined })),
    listing: sudoListing,
  },
  {
    name: 't passwd (not a plan tool)',
    grant: sudoGrant(),
    seen: sudoSeen(terminal({ program: 'passwd', foreground: { pid: 11, pgid: 11, comm: 'passwd', argv: 'passwd' } })),
    listing: sudoListing,
  },
  {
    name: 't another machine',
    grant: sudoGrant(),
    seen: sudoSeen(terminal(), 'sudo@other-box'),
    listing: sudoListing,
  },
  {
    name: 't a username into sudo',
    grant: sudoGrant({ fields: new Set(['username', 'password']) }),
    seen: {
      facts: terminal(),
      matchKey: 'sudo@kirin-box',
      fields: [{ id: 'value', label: 'Username', sensitivity: 'plain' }],
    },
    listing: sudoListing,
  },
  {
    name: 't a prompt the owner never tapped',
    grant: sudoGrant(),
    seen: sudoSeen(terminal({ foreground: { pid: 11, pgid: 11, comm: 'sudo-rs', argv: 'sudo -v' } })),
    listing: sudoListing,
  },
];

/** Both matchers need the same inputs; the Vault's declarations are structurally the same shapes under other brands. */
const bothAnswers = (theGrant: SignInGrant, seen: GrantSighting, pinned: ReadonlyMap<string, string>) => ({
  ours: matchSignInGrant(theGrant, seen, pinned),
  vault: vaultMatchSignInGrant(
    theGrant as unknown as VaultGrant,
    {
      ...seen,
      listing: seen.listing as unknown as VaultListing,
    } as unknown as VaultSighting,
    pinned,
  ),
});

describe('appd-acc F4 matchSignInGrant: both copies answer every row the same, for a plan line and a standing rule', () => {
  for (const row of ROWS)
    for (const source of ['plan', 'rule'] as const)
      it(`appd-acc F4 check ${row.name} (${source === 'plan' ? 'a plan line' : 'a standing rule'}): same answer`, () => {
        const make = source === 'plan' ? planGrant : ruleGrant;
        const { ours, vault } = bothAnswers(make(row.grant), sighting(row.seen, row.listing), new Map());
        should(vault).eql(ours);
      });

  it('appd-acc F4 should not be vacuous: the rows reach many different answers, fills and misses', () => {
    const reasons = new Set<string>();
    for (const row of ROWS)
      for (const make of [planGrant, ruleGrant]) {
        const { ours } = bothAnswers(make(row.grant), sighting(row.seen, row.listing), new Map());
        reasons.add(ours.ok ? 'filled' : ours.reason);
      }
    should(reasons.has('filled')).be.true();
    should(reasons.size).be.aboveOrEqual(20);
  });

  it('appd-acc F4 should agree on a pinned form: the same one fills, another misses', () => {
    const first = matchSignInGrant(planGrant(), sighting(), new Map());
    if (!first.ok) throw new Error('expected a fill');
    const pinned = new Map([[first.fieldSet, first.identity]]);
    const renamed = sighting({ facts: page({}, [pageField('user'), pageField('pass', {}, { name: 'pwd' })]) });
    for (const seen of [sighting(), renamed]) {
      const { ours, vault } = bothAnswers(planGrant(), seen, pinned);
      should(vault).eql(ours);
    }
  });

  it('appd-acc F4 should agree on a rule’s scope: any ferret, one session, one project', () => {
    const scopes = [
      { kind: 'any' },
      { kind: 'session', session: SESSION },
      { kind: 'session', session: 'other' },
      { kind: 'project', project: 'p1' },
    ] as const;
    for (const scope of scopes)
      for (const project of [undefined, 'p1', 'p2']) {
        const { ours, vault } = bothAnswers(
          ruleGrant({ scope: scope as never }),
          sighting({ ...(project === undefined ? {} : { project }) }),
          new Map(),
        );
        should(vault).eql(ours);
      }
  });
});
