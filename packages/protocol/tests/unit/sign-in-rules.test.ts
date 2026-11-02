import { describe, it } from 'bun:test';
import should from 'should';
import { addTwoFactorKeySubject, type TwoFactorKeySummary } from '../../src/lib/accounts.ts';
import { sha256Hex } from '../../src/lib/mcp-oauth.ts';
import { SignInRuleStageIdSchema } from '../../src/lib/account-ids.ts';
import * as rules from '../../src/lib/sign-in-rules.ts';
import {
  canonicalSignInRule,
  factorFingerprint,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_MAX,
  SIGN_IN_RULE_MAX_SECONDS,
  SIGN_IN_RULE_MIN_SECONDS,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_SUSPENSIONS,
  SIGN_IN_RULE_TERMINAL_DEFAULT_SECONDS,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TERMINAL_MAX_SECONDS,
  type SignInRuleBody,
  SignInRuleBodySchema,
  SignInRuleDraftSchema,
  SignInRuleNarrowSchema,
  type SignInRuleRecord,
  SignInRuleRecordSchema,
  SignInRulesDocumentSchema,
  SignInRuleStagedSchema,
  SignInRuleViewSchema,
  signInRuleChallenge,
  signInRuleEffective,
  signInRuleNarrowed,
  signInRuleSubject,
  signInRuleSuspensionOf,
  signInRuleSuspensionWords,
} from '../../src/lib/sign-in-rules.ts';
import {
  GRANT_MISS_REASONS,
  GRANT_STOPPING_REASONS,
  ruleMissSuspends,
  taskPlanApprovalSubject,
} from '../../src/lib/task-plan.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const DEVICE = `fy_device_id_${'d'.repeat(22)}`;
const OTHER_DEVICE = `fy_device_id_${'e'.repeat(22)}`;
const RULE = `sr_${'1'.repeat(24)}`;
const STAGE = SignInRuleStageIdSchema.parse(`srs_${'2'.repeat(24)}`);
const SIGN_IN = 'si_000000000000000a';
const KEY = `L${'A'.repeat(24)}`;
const FACTOR = 'tf_0123456789ab';
const NONCE = 'A'.repeat(43);
const PROJECT = '0b8a6c1e-6f0a-4c43-9d55-5d7bb3f5b1a2';
const CREATED = '2026-11-01T14:00:00.000Z';
const EXPIRES = '2026-12-01T14:00:00.000Z';
const HOUR = 3_600_000;
const NOW = Date.parse(CREATED) + HOUR;

const pins = {
  accountKey: KEY,
  account: 'GITHUB_KIRINNEE',
  username: 'kirinnee',
  placeKeys: ['github.com'],
  recipeVersion: 2,
  identities: ['0123456789abcdef'],
  factors: 'f'.repeat(64),
};

/** A page rule for GitHub: username and password, any ferret, 30 days, no cap. */
const body = (overrides: Partial<SignInRuleBody> = {}): SignInRuleBody => ({
  v: 1,
  id: RULE,
  revision: 1,
  signIn: SIGN_IN,
  surface: 'page',
  fields: ['username', 'password'],
  pins,
  scope: { kind: 'any' },
  createdAt: CREATED,
  expiresAt: EXPIRES,
  approvedBy: { deviceId: DEVICE },
  ...overrides,
});

/** A terminal rule for sudo on kirin-box: the password only, a day. */
const sudoBody = (overrides: Partial<SignInRuleBody> = {}): SignInRuleBody =>
  body({
    surface: 'terminal',
    fields: ['password'],
    pins: { ...pins, username: 'kirin', placeKeys: ['sudo@kirin-box'] },
    expiresAt: '2026-11-02T14:00:00.000Z',
    ...overrides,
  });

/** The same rule, also typing a code from its pinned key. */
const totpBody = (overrides: Partial<SignInRuleBody> = {}): SignInRuleBody =>
  body({ fields: ['username', 'password', 'totp'], pins: { ...pins, factor: FACTOR }, ...overrides });

const proof = {
  deviceId: DEVICE,
  credentialId: 'Y3JlZGVudGlhbC1pZA',
  clientDataJSON: 'e30',
  authenticatorData: 'AAAA',
  signature: 'MEUC',
  stage: STAGE,
  nonce: NONCE,
};

const record = (overrides: Partial<SignInRuleRecord> = {}): SignInRuleRecord => ({
  body: body(),
  proof,
  usage: { count: 0 },
  ...overrides,
});

const view = {
  id: RULE,
  revision: 1,
  signIn: SIGN_IN,
  account: { id: 'GITHUB_KIRINNEE', label: 'GitHub' },
  username: 'kirinnee',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  fields: ['username', 'password'],
  totp: false,
  scope: { kind: 'any' },
  createdAt: CREATED,
  expiresAt: EXPIRES,
  status: 'active',
  usage: { count: 14, lastUsedAt: CREATED, lastSession: 'mvx-1' },
  flags: [],
  approvedWith: { deviceId: DEVICE, device: 'Pixel 8' },
};

const staged = {
  stage: STAGE,
  rule: RULE,
  revision: 1,
  signIn: SIGN_IN,
  account: { id: 'GITHUB_KIRINNEE', label: 'GitHub' },
  place: { kind: 'site', domains: ['github.com'], match: [] },
  summary: ['Username and password and codes for GitHub · kirinnee on github.com'],
  fields: ['username', 'password', 'totp'],
  totp: true,
  root: false,
  autoRecipe: false,
  scope: { kind: 'any' },
  expiresAt: EXPIRES,
  stageExpiresAt: CREATED,
};

const canonicalOf = (value: SignInRuleBody): string => {
  const canonical = canonicalSignInRule(value);
  if (!canonical.ok) throw new Error(canonical.reason);
  return canonical.text;
};

/** The full rule with each part changed on its own: the subject-change test, and its coverage check. */
const bodyChanges = (base: SignInRuleBody): Readonly<Record<string, SignInRuleBody>> => ({
  id: { ...base, id: `sr_${'9'.repeat(24)}` },
  revision: { ...base, revision: 2 },
  signIn: { ...base, signIn: 'si_000000000000000b' },
  // A surface never changes alone: a terminal body is the password only, at one sudo, su or doas key.
  'surface: terminal': {
    ...base,
    surface: 'terminal',
    fields: ['password'],
    pins: { ...base.pins, placeKeys: ['sudo@kirin-box'], factor: undefined },
    expiresAt: '2026-11-02T14:00:00.000Z',
  },
  'fields: no username': { ...base, fields: ['password', 'totp'] },
  'fields: no code': { ...base, fields: ['username', 'password'], pins: { ...base.pins, factor: undefined } },
  'pins.accountKey': { ...base, pins: { ...base.pins, accountKey: `L${'B'.repeat(24)}` } },
  'pins.account': { ...base, pins: { ...base.pins, account: 'GITHUB_WORK' } },
  'pins.username': { ...base, pins: { ...base.pins, username: 'kirin' } },
  'pins.username absent': { ...base, pins: { ...base.pins, username: undefined } },
  'pins.placeKeys': { ...base, pins: { ...base.pins, placeKeys: ['github.com', 'api.github.com'] } },
  'pins.recipeVersion': { ...base, pins: { ...base.pins, recipeVersion: 3 } },
  'pins.recipeVersion absent': { ...base, pins: { ...base.pins, recipeVersion: undefined } },
  'pins.identities': { ...base, pins: { ...base.pins, identities: ['0123456789abcdef', '1111111111111111'] } },
  'pins.factors': { ...base, pins: { ...base.pins, factors: 'e'.repeat(64) } },
  'pins.factor': { ...base, pins: { ...base.pins, factor: 'tf_ba9876543210' } },
  'scope: project': { ...base, scope: { kind: 'project', project: PROJECT } },
  'scope: session': { ...base, scope: { kind: 'session', session: 'mvx-1' } },
  createdAt: { ...base, createdAt: '2026-11-01T15:00:00.000Z' },
  expiresAt: { ...base, expiresAt: '2026-11-30T14:00:00.000Z' },
  uses: { ...base, uses: 21 },
  'uses absent': { ...base, uses: undefined },
  approvedBy: { ...base, approvedBy: { deviceId: OTHER_DEVICE } },
});

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const suggestionView = {
  id: `srg_${'3'.repeat(16)}`,
  signIn: SIGN_IN,
  surface: 'page',
  host: 'github.com',
  why: 'I sign in here on every run',
  agenda: 'A12',
  raisedAt: CREATED,
  expiresAt: EXPIRES,
};

const cases: SchemaCase[] = [
  { name: 'rule id', schema: rules.SignInRuleIdSchema, value: RULE },
  { name: 'rule stage id', schema: rules.SignInRuleStageIdSchema, value: STAGE },
  { name: 'suggestion id', schema: rules.SignInRuleSuggestionIdSchema, value: `srg_${'3'.repeat(16)}` },
  { name: 'suggestion view', schema: rules.SignInRuleSuggestionViewSchema, value: suggestionView },
  { name: 'suggestion list', schema: rules.SignInRuleSuggestionListSchema, value: { suggestions: [suggestionView] } },
  { name: 'revision', schema: rules.SignInRuleRevisionSchema, value: 2 },
  { name: 'scope: any', schema: rules.SignInRuleScopeSchema, value: { kind: 'any' } },
  { name: 'scope: project', schema: rules.SignInRuleScopeSchema, value: { kind: 'project', project: PROJECT } },
  { name: 'scope: session', schema: rules.SignInRuleScopeSchema, value: { kind: 'session', session: 'mvx-1' } },
  { name: 'pins', schema: rules.SignInRulePinsSchema, value: pins },
  { name: 'body', schema: SignInRuleBodySchema, value: body() },
  { name: 'body with a code and a cap', schema: SignInRuleBodySchema, value: totpBody({ uses: 20 }) },
  { name: 'surface', schema: rules.SignInRuleSurfaceSchema, value: 'terminal' },
  { name: 'a terminal body: sudo, the password only', schema: SignInRuleBodySchema, value: sudoBody() },
  { name: 'proof', schema: rules.SignInRuleProofSchema, value: proof },
  { name: 'suspension', schema: rules.SignInRuleSuspensionSchema, value: 'scripted-origin' },
  { name: 'usage', schema: rules.SignInRuleUsageSchema, value: { count: 3, lastUsedAt: CREATED } },
  { name: 'narrowed', schema: rules.SignInRuleNarrowedSchema, value: { expiresAt: CREATED, uses: 2 } },
  { name: 'record', schema: SignInRuleRecordSchema, value: record() },
  { name: 'a terminal record', schema: SignInRuleRecordSchema, value: record({ body: sudoBody() }) },
  {
    name: 'record suspended and narrowed',
    schema: SignInRuleRecordSchema,
    value: record({
      body: totpBody({ uses: 20 }),
      suspended: { at: CREATED, because: 'form-changed' },
      narrowed: { dropTotp: true, expiresAt: CREATED, uses: 5 },
      usage: { count: 4, lastUsedAt: CREATED, lastSession: 'mvx-1' },
    }),
  },
  { name: 'document', schema: SignInRulesDocumentSchema, value: { v: 1, rules: [record()] } },
  { name: 'status', schema: rules.SignInRuleStatusSchema, value: 'used-up' },
  { name: 'flag', schema: rules.SignInRuleFlagSchema, value: 'auto-recipe' },
  { name: 'view', schema: SignInRuleViewSchema, value: view },
  {
    name: 'view of a suspended one-factor rule',
    schema: SignInRuleViewSchema,
    value: {
      ...view,
      fields: ['username', 'password', 'totp'],
      totp: true,
      flags: ['one-factor', 'auto-recipe'],
      uses: 20,
      remaining: 6,
      status: 'suspended',
      suspended: { at: CREATED, because: 'passkey-removed' },
      approvedWith: { deviceId: DEVICE },
    },
  },
  {
    name: 'view of a terminal rule, flagged root',
    schema: SignInRuleViewSchema,
    value: {
      ...view,
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
      fields: ['password'],
      flags: ['root'],
    },
  },
  { name: 'draft', schema: SignInRuleDraftSchema, value: { signIn: SIGN_IN, fields: ['username', 'password'] } },
  {
    name: 'draft with a code, a scope, a lifetime and a cap',
    schema: SignInRuleDraftSchema,
    value: {
      signIn: SIGN_IN,
      fields: ['password'],
      totp: true,
      totpAcknowledged: true,
      scope: { kind: 'session', session: 'mvx-1' },
      lifetimeSeconds: 7 * 86_400,
      uses: 10,
      replaces: RULE,
    },
  },
  { name: 'staged', schema: SignInRuleStagedSchema, value: staged },
  {
    name: 'staged for sudo, flagged root',
    schema: SignInRuleStagedSchema,
    value: {
      ...staged,
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
      fields: ['password'],
      totp: false,
      root: true,
    },
  },
  {
    name: 'staged at the machine',
    schema: SignInRuleStagedSchema,
    value: { ...staged, machine: { askedAt: CREATED } },
  },
  { name: 'stage state', schema: rules.SignInRuleStageStateSchema, value: 'denied' },
  { name: 'stage view', schema: rules.SignInRuleStageViewSchema, value: { ...staged, state: 'waiting' } },
  {
    name: 'list',
    schema: rules.SignInRuleListSchema,
    value: { health: 'damaged', rules: [view], stages: [{ ...staged, machine: { askedAt: CREATED } }] },
  },
  { name: 'narrow', schema: SignInRuleNarrowSchema, value: { dropTotp: true } },
  { name: 'ineligible', schema: rules.SignInRuleIneligibleSchema, value: 'no-history' },
  { name: 'eligibility: yes', schema: rules.SignInRuleEligibilitySchema, value: { signIn: SIGN_IN, eligible: true } },
  {
    name: 'eligibility: no, with its rule',
    schema: rules.SignInRuleEligibilitySchema,
    value: { signIn: SIGN_IN, eligible: false, because: 'tool-not-covered', rule: RULE },
  },
];

describe('standing sign-in rules: the wire', () => {
  it('should round-trip every record and cover every exported schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(rules, cases);
  });

  it('should carry the honest-client line, word for word', () => {
    should(SIGN_IN_RULE_HONEST_LIMIT).equal(
      "This stops a ferret putting the password anywhere else, or granting itself a rule, through Ferretry. It can't stop a ferret that reads Ferretry's own files, and any ferret may use this sign-in while the rule lasts.",
    );
  });

  it('should refuse a body that is not exactly a version 1 page rule', () => {
    assertRejects([
      { name: 'version 2', schema: SignInRuleBodySchema, value: { ...body(), v: 2 } },
      { name: 'an unknown key', schema: SignInRuleBodySchema, value: { ...body(), origin: 'https://github.com' } },
      {
        name: 'a pin it does not know',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, url: 'x' } as never }),
      },
      { name: 'a rule id that is a stage', schema: SignInRuleBodySchema, value: body({ id: STAGE }) },
      { name: 'revision 0', schema: SignInRuleBodySchema, value: body({ revision: 0 }) },
      {
        name: 'a device that is not a paired one',
        schema: SignInRuleBodySchema,
        value: body({ approvedBy: { deviceId: 'host' } }),
      },
      { name: 'no field', schema: SignInRuleBodySchema, value: body({ fields: [] }) },
      { name: 'a field twice', schema: SignInRuleBodySchema, value: body({ fields: ['password', 'password'] }) },
      {
        name: 'a code with no pinned key',
        schema: SignInRuleBodySchema,
        value: body({ fields: ['password', 'totp'] }),
      },
      {
        name: 'a pinned key with no code',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, factor: FACTOR } }),
      },
      {
        name: 'a code with no password',
        schema: SignInRuleBodySchema,
        value: body({ fields: ['totp'], pins: { ...pins, factor: FACTOR } }),
      },
      {
        name: 'no identity: a rule never pins a new form',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, identities: [] } }),
      },
      {
        name: 'an identity twice',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, identities: ['0123456789abcdef', '0123456789abcdef'] } }),
      },
      {
        name: 'a login domain twice',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, placeKeys: ['github.com', 'github.com'] } }),
      },
      {
        name: 'a fingerprint that is not one',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, factors: 'f'.repeat(63) } }),
      },
      { name: 'a cap of 0', schema: SignInRuleBodySchema, value: body({ uses: 0 }) },
      {
        name: 'a cap over the most',
        schema: SignInRuleBodySchema,
        value: body({ uses: rules.SIGN_IN_RULE_MAX_USES + 1 }),
      },
      {
        name: 'a scope kind this build does not know',
        schema: SignInRuleBodySchema,
        value: body({ scope: { kind: 'team' } as never }),
      },
      {
        name: 'the Unfiled project: only a stamped, registered project narrows',
        schema: SignInRuleBodySchema,
        value: body({ scope: { kind: 'project', project: 'unfiled' } as never }),
      },
    ]);
  });

  // Invariant 36 (R3c §14): lifetime bounds are signed, a page rule's and a terminal rule's (!A197).
  it('should bound a page rule between one hour and 90 days, and a terminal rule to 7 days', () => {
    // Arrange
    const ending = (seconds: number): string => new Date(Date.parse(CREATED) + seconds * 1_000).toISOString();

    // Act / Assert
    should(SIGN_IN_RULE_MIN_SECONDS).equal(3_600);
    should(SIGN_IN_RULE_MAX_SECONDS).equal(90 * 86_400);
    should(SIGN_IN_RULE_TERMINAL_DEFAULT_SECONDS).equal(86_400);
    should(SIGN_IN_RULE_TERMINAL_MAX_SECONDS).equal(7 * 86_400);
    should(rules.signInRuleLifetime('page')).deepEqual({
      defaultSeconds: 30 * 86_400,
      maxSeconds: 90 * 86_400,
      maxDays: 90,
    });
    should(rules.signInRuleLifetime('terminal')).deepEqual({
      defaultSeconds: 86_400,
      maxSeconds: 7 * 86_400,
      maxDays: 7,
    });
    should(SignInRuleBodySchema.safeParse(body({ expiresAt: ending(SIGN_IN_RULE_MIN_SECONDS) })).success).be.true();
    should(SignInRuleBodySchema.safeParse(body({ expiresAt: ending(SIGN_IN_RULE_MAX_SECONDS) })).success).be.true();
    should(SignInRuleBodySchema.safeParse(sudoBody({ expiresAt: ending(SIGN_IN_RULE_MIN_SECONDS) })).success).be.true();
    should(
      SignInRuleBodySchema.safeParse(sudoBody({ expiresAt: ending(SIGN_IN_RULE_TERMINAL_MAX_SECONDS) })).success,
    ).be.true();
    assertRejects([
      {
        name: 'over 90 days',
        schema: SignInRuleBodySchema,
        value: body({ expiresAt: ending(SIGN_IN_RULE_MAX_SECONDS + 1) }),
      },
      {
        name: 'under an hour',
        schema: SignInRuleBodySchema,
        value: body({ expiresAt: ending(SIGN_IN_RULE_MIN_SECONDS - 1) }),
      },
      { name: 'ending before it begins', schema: SignInRuleBodySchema, value: body({ expiresAt: ending(-86_400) }) },
      {
        name: 'a terminal rule over 7 days',
        schema: SignInRuleBodySchema,
        value: sudoBody({ expiresAt: ending(SIGN_IN_RULE_TERMINAL_MAX_SECONDS + 1) }),
      },
      {
        name: 'a terminal rule for 30 days, as a page rule may',
        schema: SignInRuleBodySchema,
        value: sudoBody({ expiresAt: EXPIRES }),
      },
      {
        name: 'a terminal rule under an hour',
        schema: SignInRuleBodySchema,
        value: sudoBody({ expiresAt: ending(SIGN_IN_RULE_MIN_SECONDS - 1) }),
      },
      {
        name: 'a draft lasting over 90 days',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], lifetimeSeconds: SIGN_IN_RULE_MAX_SECONDS + 1 },
      },
      {
        name: 'a draft lasting under an hour',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], lifetimeSeconds: 3_599 },
      },
    ]);
    // Nothing the canonical bytes would bind can carry a lifetime the schema refuses.
    should(canonicalSignInRule(body({ expiresAt: ending(SIGN_IN_RULE_MAX_SECONDS + 1) })).ok).be.false();
    should(canonicalSignInRule(sudoBody({ expiresAt: ending(SIGN_IN_RULE_TERMINAL_MAX_SECONDS + 1) })).ok).be.false();
  });

  // Invariant 24 (R3c §14, restored by !A197): terminal rules are sudo, su or doas only, the password only.
  it('should take a terminal rule only for one sudo, su or doas key, typing the password alone', () => {
    // Arrange
    const at = (placeKeys: string[]): SignInRuleBody => sudoBody({ pins: { ...sudoBody().pins, placeKeys } });

    // Act / Assert
    for (const key of ['sudo@kirin-box', 'su@kirin-box', 'doas@kirin-box'])
      should(SignInRuleBodySchema.safeParse(at([key])).success).be.true();
    assertRejects([
      { name: 'a terminal rule for ssh', schema: SignInRuleBodySchema, value: at(['ssh@prod.example.com']) },
      { name: 'a terminal rule for npm', schema: SignInRuleBodySchema, value: at(['npm@kirin-box']) },
      { name: 'a terminal rule for passwd', schema: SignInRuleBodySchema, value: at(['passwd@kirin-box']) },
      { name: 'a terminal rule with no host', schema: SignInRuleBodySchema, value: at(['sudo']) },
      { name: 'a terminal rule at a web host', schema: SignInRuleBodySchema, value: at(['github.com']) },
      {
        name: 'a terminal rule at two terminal keys',
        schema: SignInRuleBodySchema,
        value: at(['sudo@kirin-box', 'su@kirin-box']),
      },
      {
        name: 'a terminal rule typing a username',
        schema: SignInRuleBodySchema,
        value: sudoBody({ fields: ['username', 'password'] }),
      },
      {
        name: 'a terminal rule typing a code',
        schema: SignInRuleBodySchema,
        value: sudoBody({ fields: ['password', 'totp'], pins: { ...sudoBody().pins, factor: FACTOR } }),
      },
      {
        name: 'a page rule pinned to sudo on this machine',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, placeKeys: ['sudo@kirin-box'] } }),
      },
      {
        name: 'a page rule with a web host beside a terminal key',
        schema: SignInRuleBodySchema,
        value: body({ pins: { ...pins, placeKeys: ['github.com', 'su@kirin-box'] } }),
      },
      {
        name: 'a surface this build does not know',
        schema: SignInRuleBodySchema,
        value: { ...body(), surface: 'ssh' },
      },
    ]);
    should(rules.signInRuleKeysFit('terminal', ['sudo@kirin-box'])).be.true();
    should(rules.signInRuleKeysFit('terminal', [])).be.false();
    should(rules.signInRuleKeysFit('page', ['sudo@kirin-box'])).be.false();
  });

  it('should sign the surface: a terminal rule’s bytes say so, and no page bytes ever read as a terminal rule', () => {
    // Arrange
    const sudo = canonicalOf(sudoBody());

    // Act / Assert
    should(JSON.parse(sudo)).have.property('surface', 'terminal');
    should(JSON.parse(canonicalOf(body()))).have.property('surface', 'page');
    // The page body with only its surface turned is no rule at all: nothing to bind.
    should(canonicalSignInRule({ ...body(), surface: 'terminal' }).ok).be.false();
    should(canonicalSignInRule({ ...sudoBody(), surface: 'page' }).ok).be.false();
  });

  it('should carry the root warning and the terminal honest limit, word for word', () => {
    should(SIGN_IN_RULE_ROOT_WARNING).equal(
      'This gives every ferret on this machine root whenever it asks, while the rule lasts.',
    );
    should(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT).equal(
      'Ferretry types it only where the kernel proves sudo, su or doas is reading the terminal as root, never on a name a process gave itself. A ferret starts that program, so it could start another program root installed under the name sudo.',
    );
    should(SIGN_IN_RULE_TERMINAL_RESIDUAL).equal(
      "In the split second between Ferretry's last check and the moment it types, a ferret could swap in its own program and read the password once; Ferretry then stops the rule and tells you.",
    );
  });

  it('should flag a terminal rule root, and only a terminal rule, in the view and the stage (secrev-1268 N1)', () => {
    // Arrange
    const sudoPlace = { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } as const;
    const sudoStaged = { ...staged, place: sudoPlace, fields: ['password'], totp: false, root: true };
    const sudoView = { ...view, place: sudoPlace, fields: ['password'], flags: ['root'] };

    // Act / Assert — the structured flag decides the red line, whatever the summary says
    should(SignInRuleStagedSchema.parse({ ...sudoStaged, summary: ['x'.repeat(240)] }).root).be.true();
    assertRejects([
      { name: 'a sudo stage not flagged root', schema: SignInRuleStagedSchema, value: { ...sudoStaged, root: false } },
      { name: 'a page stage flagged root', schema: SignInRuleStagedSchema, value: { ...staged, root: true } },
      {
        name: 'a stage with no root flag at all',
        schema: SignInRuleStagedSchema,
        value: { ...staged, root: undefined },
      },
      {
        name: 'a sudo stage typing a username',
        schema: SignInRuleStagedSchema,
        value: { ...sudoStaged, fields: ['username', 'password'] },
      },
      {
        name: 'an ssh stage',
        schema: SignInRuleStagedSchema,
        value: { ...sudoStaged, place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'prod.example.com' } },
      },
      { name: 'a sudo view not flagged root', schema: SignInRuleViewSchema, value: { ...sudoView, flags: [] } },
      { name: 'a page view flagged root', schema: SignInRuleViewSchema, value: { ...view, flags: ['root'] } },
      {
        name: 'a stage view for sudo not flagged root',
        schema: rules.SignInRuleStageViewSchema,
        value: { ...sudoStaged, root: false, state: 'waiting' },
      },
    ]);
  });
});

// Invariant 4 (R3c §14): the passkey's challenge commits to the canonical bytes.
describe('standing sign-in rules: the bytes the passkey is bound to', () => {
  it('should give the same bytes for the same rule, whatever order its sets were written in', () => {
    // Arrange
    const shuffled = body({
      fields: ['password', 'username'],
      pins: {
        ...pins,
        placeKeys: ['github.com', 'api.github.com'],
        identities: ['ffffffffffffffff', '0123456789abcdef'],
      },
    });
    const sorted = body({
      fields: ['username', 'password'],
      pins: {
        ...pins,
        placeKeys: ['api.github.com', 'github.com'],
        identities: ['0123456789abcdef', 'ffffffffffffffff'],
      },
    });

    // Act
    const first = canonicalOf(shuffled);
    const second = canonicalOf(sorted);

    // Assert
    should(first).equal(second);
    should(first).equal(canonicalOf(shuffled));
    should(signInRuleSubject(STAGE, first)).equal(signInRuleSubject(STAGE, second));
    should(hex(signInRuleChallenge(NONCE, signInRuleSubject(STAGE, first)))).equal(
      hex(signInRuleChallenge(NONCE, signInRuleSubject(STAGE, second))),
    );
  });

  it('should change the subject and the challenge when any one part of the body changes', () => {
    // Arrange — the full rule, every optional part present, and each part changed on its own
    const base = totpBody({ uses: 20 });
    const changes = bodyChanges(base);
    const subject = signInRuleSubject(STAGE, canonicalOf(base));
    const challenge = hex(signInRuleChallenge(NONCE, subject));

    // Act
    const changed = Object.entries(changes).map(([name, value]) => {
      const other = signInRuleSubject(STAGE, canonicalOf(value));
      return { name, subject: other !== subject, challenge: hex(signInRuleChallenge(NONCE, other)) !== challenge };
    });

    // Assert
    should(changed).deepEqual(Object.keys(changes).map(name => ({ name, subject: true, challenge: true })));
  });

  it('should cover every body and pins key in that table, so a field added later fails until it is covered', () => {
    // Arrange — the table's own names: `key`, `key: variant`, `pins.key` or `pins.key variant`
    const names = Object.keys(bodyChanges(totpBody({ uses: 20 })));
    const keyOf = (name: string): string => (name.split(' ')[0] ?? name).replace(/:$/u, '');

    // Act
    const top = new Set(names.map(keyOf).map(key => key.split('.')[0]));
    const pinned = new Set(
      names
        .map(keyOf)
        .filter(key => key.startsWith('pins.'))
        .map(key => key.slice(5)),
    );

    // Assert — `v` is a literal: it has nothing to change to
    should(Object.keys(SignInRuleBodySchema.shape).filter(key => !top.has(key))).deepEqual(['v']);
    should(Object.keys(rules.SignInRulePinsSchema.shape).filter(key => !pinned.has(key))).deepEqual([]);
  });

  it('should sign every key of the body, so a field added later is never left out', () => {
    // Arrange
    const full = totpBody({ uses: 20 });

    // Act
    const signed = JSON.parse(canonicalOf(full)) as Record<string, unknown> & { pins: Record<string, unknown> };

    // Assert
    should(Object.keys(signed).sort()).deepEqual(Object.keys(SignInRuleBodySchema.shape).sort());
    should(Object.keys(signed.pins).sort()).deepEqual(Object.keys(rules.SignInRulePinsSchema.shape).sort());
  });

  it('should bind a proof to its stage and its nonce', () => {
    // Arrange
    const canonical = canonicalOf(body());
    const subject = signInRuleSubject(STAGE, canonical);

    // Act / Assert
    should(signInRuleSubject(SignInRuleStageIdSchema.parse(`srs_${'3'.repeat(24)}`), canonical)).not.equal(subject);
    should(hex(signInRuleChallenge(`${'B'.repeat(42)}A`, subject))).not.equal(hex(signInRuleChallenge(NONCE, subject)));
    should(signInRuleChallenge(NONCE, subject)).have.length(32);
    should(hex(signInRuleChallenge(NONCE, subject))).equal(
      sha256Hex(`ferretry.sign-in-rule.challenge.v1\0${NONCE}\0${subject}`),
    );
    should(subject).equal(sha256Hex(`ferretry.sign-in-rule.v1\0${STAGE}\0${sha256Hex(canonical)}`));
  });

  it('should keep a rule subject apart from a task plan approval and a 2FA seed over the same inputs', () => {
    // Arrange
    const canonical = canonicalOf(body());

    // Act
    const rule = signInRuleSubject(STAGE, canonical);
    const plan = taskPlanApprovalSubject(STAGE, canonical);
    const seed = addTwoFactorKeySubject(KEY, STAGE);

    // Assert — one string, three domains: no proof made for one can ever be read as another's
    should(new Set([rule, plan, seed]).size).equal(3);
    // ...and the challenge is not the subject either: a rule's challenge never equals anything else's subject
    should(hex(signInRuleChallenge(NONCE, rule))).not.equal(rule);
  });

  it('should refuse to bind a body that does not parse', () => {
    should(canonicalSignInRule(body({ fields: ['password', 'totp'] })).ok).be.false();
    should(canonicalSignInRule({ ...body(), extra: true } as never).ok).be.false();
  });
});

describe('standing sign-in rules: the 2FA key fingerprint', () => {
  const key = (overrides: Partial<TwoFactorKeySummary> = {}): TwoFactorKeySummary =>
    ({
      id: FACTOR,
      kind: 'totp',
      label: 'Phone',
      addedAt: CREATED,
      addedBy: 'owner',
      automatic: true,
      params: { digits: 6, period: 30, algorithm: 'SHA1' },
      ...overrides,
    }) as TwoFactorKeySummary;
  const sms = {
    id: 'tf_aaaaaaaaaaaa',
    kind: 'sms',
    label: 'Texts',
    addedAt: CREATED,
    addedBy: 'owner',
    automatic: false,
  } as const;

  it('should not move when a key is checked by use, relabelled, re-dated or listed in another order', () => {
    // Arrange
    const base = factorFingerprint([key(), sms]);

    // Act / Assert — `verified` is something a ferret can steer, so it gates nothing
    should(factorFingerprint([sms, key()])).equal(base);
    should(factorFingerprint([key({ verified: { worked: false, at: CREATED } } as never), sms])).equal(base);
    should(factorFingerprint([key({ label: 'Work phone' }), sms])).equal(base);
    should(factorFingerprint([key({ addedAt: '2026-10-01T00:00:00.000Z' }), sms])).equal(base);
    should(base).match(/^[0-9a-f]{64}$/u);
  });

  it('should move when a key is added, removed, or changes its kind or its seed', () => {
    // Arrange
    const base = factorFingerprint([key(), sms]);

    // Act / Assert
    should(factorFingerprint([key()])).not.equal(base);
    should(factorFingerprint([key(), sms, key({ id: 'tf_bbbbbbbbbbbb' })])).not.equal(base);
    should(factorFingerprint([key({ id: 'tf_bbbbbbbbbbbb' }), sms])).not.equal(base);
    should(factorFingerprint([key({ automatic: false, params: undefined } as never), sms])).not.equal(base);
    should(factorFingerprint([key(), { ...sms, kind: 'email' } as never])).not.equal(base);
    should(factorFingerprint([])).not.equal(base);
  });
});

describe('standing sign-in rules: the record on disk', () => {
  it('should refuse a record whose unsigned overlay would widen the signed body', () => {
    assertRejects([
      {
        name: 'a proof from another device',
        schema: SignInRuleRecordSchema,
        value: record({ proof: { ...proof, deviceId: OTHER_DEVICE } }),
      },
      {
        name: 'a proof for no stage',
        schema: SignInRuleRecordSchema,
        value: record({ proof: { ...proof, stage: RULE as never } }),
      },
      {
        name: 'a short nonce',
        schema: SignInRuleRecordSchema,
        value: record({ proof: { ...proof, nonce: 'A'.repeat(42) } }),
      },
      {
        name: 'a later end',
        schema: SignInRuleRecordSchema,
        value: record({ narrowed: { expiresAt: '2026-12-02T14:00:00.000Z' } }),
      },
      {
        name: 'an end before it began',
        schema: SignInRuleRecordSchema,
        value: record({ narrowed: { expiresAt: '2026-10-01T14:00:00.000Z' } }),
      },
      {
        name: 'more uses than approved',
        schema: SignInRuleRecordSchema,
        value: record({ body: body({ uses: 5 }), narrowed: { uses: 6 } }),
      },
      {
        name: 'dropping a code it never typed',
        schema: SignInRuleRecordSchema,
        value: record({ narrowed: { dropTotp: true } }),
      },
      {
        name: 'a suspension it does not know',
        schema: SignInRuleRecordSchema,
        value: record({ suspended: { at: CREATED, because: 'bored' } as never }),
      },
      { name: 'no usage', schema: SignInRuleRecordSchema, value: { body: body(), proof } },
    ]);
  });

  // Invariant 8's protocol half: a strict document, or none.
  it('should refuse a whole document that is not exactly version 1 with one rule per id and per sign-in', () => {
    // Arrange
    const second = record({ body: body({ id: `sr_${'4'.repeat(24)}`, signIn: 'si_000000000000000b' }) });

    // Act / Assert
    should(SignInRulesDocumentSchema.safeParse({ v: 1, rules: [record(), second] }).success).be.true();
    should(SignInRulesDocumentSchema.safeParse({ v: 1, rules: [] }).success).be.true();
    assertRejects([
      { name: 'version 2', schema: SignInRulesDocumentSchema, value: { v: 2, rules: [] } },
      { name: 'no version', schema: SignInRulesDocumentSchema, value: { rules: [] } },
      { name: 'an extra key', schema: SignInRulesDocumentSchema, value: { v: 1, rules: [], plans: [] } },
      {
        name: 'one id twice',
        schema: SignInRulesDocumentSchema,
        value: { v: 1, rules: [record(), record({ body: body({ signIn: 'si_000000000000000b' }) })] },
      },
      {
        name: 'two rules for one sign-in',
        schema: SignInRulesDocumentSchema,
        value: { v: 1, rules: [record(), record({ body: body({ id: `sr_${'4'.repeat(24)}` }) })] },
      },
      {
        name: 'more rules than a machine keeps',
        schema: SignInRulesDocumentSchema,
        value: {
          v: 1,
          rules: Array.from({ length: SIGN_IN_RULE_MAX + 1 }, (_, index) =>
            record({
              body: body({
                id: `sr_${index.toString(16).padStart(24, '0')}`,
                signIn: `si_${index.toString(16).padStart(16, '0')}`,
              }),
            }),
          ),
        },
      },
      {
        name: 'one bad record',
        schema: SignInRulesDocumentSchema,
        value: { v: 1, rules: [record(), { ...second, extra: 1 }] },
      },
    ]);
  });
});

describe('standing sign-in rules: what is in force', () => {
  it('should read the overlay as only ever taking away', () => {
    // Arrange
    const narrowed = record({
      body: totpBody({ uses: 20 }),
      narrowed: { dropTotp: true, expiresAt: '2026-11-10T14:00:00.000Z', uses: 30 },
      usage: { count: 4 },
    });

    // Act
    const effective = signInRuleEffective(narrowed, NOW);

    // Assert — the lower cap of the two wins, the earlier end, and no code
    should(effective).deepEqual({
      fields: ['username', 'password'],
      expiresAt: '2026-11-10T14:00:00.000Z',
      uses: 20,
      remaining: 16,
      status: 'active',
    });
  });

  it('should say suspended first, then expired, then used-up', () => {
    // Arrange
    const spent = record({ body: body({ uses: 2 }), usage: { count: 2 } });
    const late = Date.parse(EXPIRES);

    // Act / Assert
    should(signInRuleEffective(record(), NOW).status).equal('active');
    should(signInRuleEffective(record(), NOW).uses).be.undefined();
    should(signInRuleEffective(spent, NOW).status).equal('used-up');
    should(signInRuleEffective(spent, late).status).equal('expired');
    should(signInRuleEffective(record(), late).status).equal('expired');
    should(signInRuleEffective({ ...spent, suspended: { at: CREATED, because: 'form-changed' } }, late).status).equal(
      'suspended',
    );
    should(signInRuleEffective(record({ narrowed: { expiresAt: CREATED } }), NOW).status).equal('expired');
  });

  // Invariant 20's protocol half: narrowing can't widen.
  it('should narrow only strictly: an earlier end, fewer uses, or dropping a code it types', () => {
    // Arrange
    const capped = record({ body: totpBody({ uses: 10 }) });

    // Act / Assert
    should(signInRuleNarrowed(capped, { uses: 3 }, NOW)).deepEqual({ ok: true, narrowed: { uses: 3 } });
    should(signInRuleNarrowed(record(), { uses: 50 }, NOW)).deepEqual({ ok: true, narrowed: { uses: 50 } });
    should(signInRuleNarrowed(capped, { dropTotp: true, expiresAt: '2026-11-05T00:00:00.000Z' }, NOW)).deepEqual({
      ok: true,
      narrowed: { dropTotp: true, expiresAt: '2026-11-05T00:00:00.000Z' },
    });
    should(
      signInRuleNarrowed(record({ ...capped, narrowed: { uses: 3 } }), { expiresAt: '2026-11-05T00:00:00.000Z' }, NOW),
    ).deepEqual({ ok: true, narrowed: { uses: 3, expiresAt: '2026-11-05T00:00:00.000Z' } });
    for (const narrow of [
      { uses: 10 },
      { uses: 11 },
      { expiresAt: EXPIRES },
      { expiresAt: '2026-12-02T14:00:00.000Z' },
      { expiresAt: '2026-10-01T00:00:00.000Z' },
    ])
      should(signInRuleNarrowed(capped, narrow, NOW).ok).be.false();
    should(signInRuleNarrowed(record(), { dropTotp: true }, NOW).ok).be.false();
    should(
      signInRuleNarrowed(record({ body: totpBody(), narrowed: { dropTotp: true } }), { dropTotp: true }, NOW).ok,
    ).be.false();
    should(signInRuleNarrowed(record({ ...capped, narrowed: { uses: 3 } }), { uses: 5 }, NOW).ok).be.false();
    assertRejects([
      { name: 'a narrowing that narrows nothing', schema: SignInRuleNarrowSchema, value: {} },
      { name: 'adding a field', schema: SignInRuleNarrowSchema, value: { fields: ['totp'] } },
      { name: 'a wider scope', schema: SignInRuleNarrowSchema, value: { scope: { kind: 'any' } } },
      { name: 'keeping the code', schema: SignInRuleNarrowSchema, value: { dropTotp: false } },
    ]);
  });
});

describe('standing sign-in rules: suspension', () => {
  it('should suspend a rule for every miss that stops a plan line, and for the sign-in gone', () => {
    // Act / Assert
    for (const reason of GRANT_STOPPING_REASONS) should(signInRuleSuspensionOf(reason)).equal(reason);
    should(signInRuleSuspensionOf('sign-in-gone')).equal('sign-in-gone');
    should(signInRuleSuspensionOf('rate')).be.undefined();
    should(signInRuleSuspensionOf('out-of-scope')).be.undefined();
    // The owner's words say "suspended" for exactly the misses that suspend (and one already suspended).
    for (const reason of GRANT_MISS_REASONS)
      should(ruleMissSuspends(reason)).equal(reason === 'suspended' || signInRuleSuspensionOf(reason) !== undefined);
  });

  it('should give every suspension the owner a sentence, and name no account in it', () => {
    // Act
    const words = SIGN_IN_RULE_SUSPENSIONS.map(signInRuleSuspensionWords);

    // Assert
    should(
      words.every(sentence => sentence.length > 0 && !SIGN_IN_RULE_SUSPENSIONS.includes(sentence as never)),
    ).be.true();
    should(signInRuleSuspensionWords('passkey-removed')).equal('the passkey or device that approved it was removed');
    should(signInRuleSuspensionWords('form-changed')).equal('the sign-in form changed since you approved it');
  });
});

describe('standing sign-in rules: what the owner sees and sends', () => {
  it('should draw every warning from structured fields that agree with each other', () => {
    assertRejects([
      {
        name: 'a code with no one-factor flag',
        schema: SignInRuleViewSchema,
        value: { ...view, fields: ['password', 'totp'], totp: true },
      },
      {
        name: 'a one-factor flag with no code',
        schema: SignInRuleViewSchema,
        value: { ...view, flags: ['one-factor'] },
      },
      {
        name: 'totp that disagrees with the fields',
        schema: SignInRuleViewSchema,
        value: { ...view, totp: true, flags: ['one-factor'] },
      },
      { name: 'a flag twice', schema: SignInRuleViewSchema, value: { ...view, flags: ['auto-recipe', 'auto-recipe'] } },
      { name: 'suspended with no reason', schema: SignInRuleViewSchema, value: { ...view, status: 'suspended' } },
      {
        name: 'a reason on an active rule',
        schema: SignInRuleViewSchema,
        value: { ...view, suspended: { at: CREATED, because: 'form-changed' } },
      },
      { name: 'uses left with no cap', schema: SignInRuleViewSchema, value: { ...view, remaining: 2 } },
      { name: 'more left than the cap', schema: SignInRuleViewSchema, value: { ...view, uses: 2, remaining: 3 } },
      {
        name: 'a terminal place',
        schema: SignInRuleViewSchema,
        value: { ...view, place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } },
      },
      { name: 'a staged code the totp flag hides', schema: SignInRuleStagedSchema, value: { ...staged, totp: false } },
      {
        name: 'a staged totp flag with no code',
        schema: SignInRuleStagedSchema,
        value: { ...staged, fields: ['username', 'password'] },
      },
      { name: 'a staged rule with no words', schema: SignInRuleStagedSchema, value: { ...staged, summary: [] } },
      {
        name: 'a staged summary line with a line break',
        schema: SignInRuleStagedSchema,
        value: { ...staged, summary: ['one\ntwo'] },
      },
      {
        name: 'a stage view whose code the totp flag hides',
        schema: rules.SignInRuleStageViewSchema,
        value: { ...staged, totp: false, state: 'waiting' },
      },
    ]);
  });

  it('should ask for the code only as its own tick, acknowledged, beside the password', () => {
    assertRejects([
      {
        name: 'the code with no acknowledgement',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], totp: true },
      },
      {
        name: 'an acknowledgement with no code',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], totpAcknowledged: true },
      },
      {
        name: 'the code as a field',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password', 'totp'] },
      },
      {
        name: 'the code with no password',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['username'], totp: true, totpAcknowledged: true },
      },
      {
        name: 'a field twice',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password', 'password'] },
      },
      {
        name: 'a domain of its own',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], placeKeys: ['evil.test'] },
      },
      {
        name: 'a pin of its own',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], identities: ['0123456789abcdef'] },
      },
      {
        name: 'replacing a stage',
        schema: SignInRuleDraftSchema,
        value: { signIn: SIGN_IN, fields: ['password'], replaces: STAGE },
      },
    ]);
  });
});

describe('standing sign-in rules: review fixes (secrev-1271)', () => {
  // L3: which sign-in a staged rule is for is a field, never only words a clip can cut.
  it('should name the staged rule’s account and sign-in as fields', () => {
    // Arrange
    const { account: _account, ...noAccount } = staged;
    const { place: _place, ...noPlace } = staged;
    const longLabel = { ...staged, summary: [`Username and password and codes for ${'G'.repeat(200)}`] };

    // Act / Assert — the host survives a summary clipped before it
    should(SignInRuleStagedSchema.parse(longLabel).place).deepEqual({
      kind: 'site',
      domains: ['github.com'],
      match: [],
    });
    assertRejects([
      { name: 'a staged rule with no account', schema: SignInRuleStagedSchema, value: noAccount },
      { name: 'a staged rule with no place', schema: SignInRuleStagedSchema, value: noPlace },
      {
        name: 'a staged rule for a terminal, typing a username and a code',
        schema: SignInRuleStagedSchema,
        value: { ...staged, place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' }, root: true },
      },
      {
        name: 'a stage view for a terminal, typing a username and a code',
        schema: rules.SignInRuleStageViewSchema,
        value: {
          ...staged,
          place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
          root: true,
          state: 'waiting',
        },
      },
      {
        name: 'an account with no label',
        schema: SignInRuleStagedSchema,
        value: { ...staged, account: { id: 'GITHUB_KIRINNEE' } },
      },
    ]);
  });

  // L4: a rule is never in force outside its signed window, so it never reaches past 90 days from now.
  it('should refuse a rule created in the future, beyond a small clock skew, at the clock it is handed', () => {
    // Arrange — every time is fixed: the check takes its clock, and nothing here reads the machine's
    const created = Date.parse(CREATED);
    const SKEW = rules.SIGN_IN_RULE_CLOCK_SKEW_SECONDS * 1_000;

    // Act / Assert
    should(rules.SIGN_IN_RULE_CLOCK_SKEW_SECONDS).equal(300);
    should(rules.signInRuleClockProblems(body(), created + HOUR)).deepEqual([]);
    should(rules.signInRuleClockProblems(body(), created)).deepEqual([]);
    should(rules.signInRuleClockProblems(body(), created - SKEW)).deepEqual([]);
    should(rules.signInRuleClockProblems(body(), created - SKEW - 1_000)).deepEqual([
      'a rule is never created in the future',
    ]);
    should(rules.signInRuleClockProblems(body(), created - 86_400_000)).deepEqual([
      'a rule is never created in the future',
    ]);
    should(rules.signInRuleClockProblems({ createdAt: 'not a time' }, created)).deepEqual([
      'a rule is never created in the future',
    ]);
  });

  it('should keep the body schema clock-free, so a stored document parses the same way at any time', () => {
    // Arrange — a body created a year after these fixtures, which the clock check refuses
    const ahead = body({ createdAt: '2027-11-01T14:00:00.000Z', expiresAt: '2027-12-01T14:00:00.000Z' });

    // Act / Assert — the schema, the canonical bytes and the record never consult a clock; the daemon's check does
    should(SignInRuleBodySchema.safeParse(ahead).success).be.true();
    should(canonicalSignInRule(ahead).ok).be.true();
    should(SignInRuleRecordSchema.safeParse(record({ body: ahead })).success).be.true();
    should(rules.signInRuleBodyProblems(ahead)).deepEqual([]);
    should(rules.signInRuleClockProblems(ahead, Date.parse(CREATED))).not.be.empty();
  });

  it('should read a rule as not in force before its own start', () => {
    // Act / Assert — a clock that ran back is treated as outside the signed window, never as active
    should(signInRuleEffective(record(), Date.parse(CREATED) - 1).status).equal('expired');
    should(signInRuleEffective(record(), Date.parse(CREATED)).status).equal('active');
  });

  // L5: nothing is ever bound to a malformed stage, empty bytes, or a nonce not yet drawn.
  it('should refuse to derive a subject or a challenge from malformed inputs', () => {
    // Arrange
    const canonical = canonicalOf(body());
    const subject = signInRuleSubject(STAGE, canonical);

    // Act / Assert
    should(() => signInRuleSubject(`tps_${'2'.repeat(24)}` as never, canonical)).throw(RangeError);
    should(() => signInRuleSubject('' as never, canonical)).throw(RangeError);
    should(() => signInRuleSubject(STAGE, '')).throw(RangeError);
    for (const nonce of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}B`,
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
    ])
      should(() => signInRuleChallenge(nonce, subject)).throw(RangeError);
    for (const bad of ['', 'f'.repeat(63), 'F'.repeat(64), STAGE])
      should(() => signInRuleChallenge(NONCE, bad)).throw(RangeError);
    should(rules.SignInRuleProofSchema.safeParse({ ...proof, nonce: `${'A'.repeat(42)}B` }).success).be.false();
  });

  it('should take any 32 random bytes as a nonce, and only those', () => {
    // Arrange
    const subject = signInRuleSubject(STAGE, canonicalOf(body()));
    const nonces = Array.from({ length: 64 }, () =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    );

    // Act / Assert — every one is accepted, and each spells exactly 32 bytes
    for (const nonce of nonces) {
      should(signInRuleChallenge(nonce, subject)).have.length(32);
      should(Buffer.from(nonce, 'base64url').toString('base64url')).equal(nonce);
      should(Buffer.from(nonce, 'base64url')).have.length(32);
    }
    should(() => signInRuleChallenge(Buffer.alloc(31).toString('base64url'), subject)).throw(RangeError);
  });
});
