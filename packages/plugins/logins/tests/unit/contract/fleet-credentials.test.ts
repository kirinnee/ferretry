/**
 * The wire shape of an account-model credential: status and usage, never material.
 *
 * Every object is strict, so a token, a refresh token or a digest would have to arrive as an extra
 * field — and is REFUSED rather than stripped. The cases below are that property, not trivia.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as credentials from '@@EXT:protocol/src/lib/fleet-credentials.ts@@';
import type { LoginView } from '@@EXT:protocol/src/lib/index.ts@@';
import { INSTANT, LATER_INSTANT } from '@@EXT:protocol/tests/fixtures.ts@@';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from '@@EXT:protocol/tests/unit/schema-cases.ts@@';

const status = {
  word: 'ready',
  label: 'Ready',
  reason: 'provider_accepted',
  explanation: 'The provider accepted this login on its last check.',
  since: INSTANT,
  lastCheckedAt: LATER_INSTANT,
  lastCheckInconclusive: false,
} as const;

const usage = {
  fiveHour: { usedPercent: 12.5, resetsAt: LATER_INSTANT },
  weekly: {},
  source: 'anthropic-usage',
  at: INSTANT,
} as const;

const view = {
  id: 'claude-work',
  harness: 'claude',
  harnesses: ['claude', 'codex'],
  store: 'host',
  email: 'kirin@example.com',
  label: 'work',
  needsLabel: false,
  sharedWithTerminal: true,
  status,
  usage,
  usedBy: ['claude-review'],
  signIn: { available: true },
  checkNow: { available: false, reason: 'A check is running now.' },
  signOut: {
    available: true,
    sentence: 'Sign out of kirin@example.com (work)? This also signs out claude in your terminal on studio.',
    runtimesAffected: 1,
    signsOutTerminal: true,
  },
} satisfies LoginView;

const testAct = {
  available: true,
  spends: 'nothing',
  note: 'Lists the models the key can use. Spends nothing.',
} as const;

const environment = {
  preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai/devpack/tool/claude' },
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic', harness: 'claude' },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
    { name: 'PASTED', kind: 'hidden' },
  ],
  cloudCredential: {
    reference: 'aws-profile:acme',
    kind: 'aws-profile',
    sentence: 'Uses your AWS profile acme on this machine. It is named here, never copied.',
    variable: 'AWS_PROFILE',
  },
  codexProvider: { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1' },
  quotaSource: 'zai-coding-plan',
  missingSecrets: [],
  test: testAct,
} as const;

const detect = {
  hosts: ['api.z.ai', 'open.bigmodel.cn'],
  variables: ['ZAI_*', 'ZHIPUAI_*'],
  keyPrefixes: [] as string[],
};

const preset = {
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  harness: 'claude',
  summary: 'Claude Code on GLM models with a Z.ai Coding Plan key.',
  docs: 'https://docs.z.ai/devpack/tool/claude',
  group: 'popular',
  origin: 'built-in',
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.z.ai/api/anthropic',
      required: true,
      allowEmpty: false,
      harnesses: ['claude'],
    },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY', required: true, allowEmpty: false },
  ],
  cloudCredential: { kinds: ['aws-profile'], suggested: 'aws-profile:default' },
  models: ['glm-5.3'],
  test: testAct,
  quota: { source: 'zai-coding-plan', note: 'A 5-hour and a weekly window.' },
  unverified: ['The quota endpoint is described by community tools.'],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [
    { harness: 'claude', offered: { available: true }, models: ['glm-5.3'] },
    {
      harness: 'codex',
      offered: { available: false, reason: 'Z.ai serves the Responses API, but Codex has no model catalogue file.' },
      docs: 'https://docs.z.ai/devpack/tool/codex',
      models: ['glm-5.3'],
    },
  ],
  detect,
} as const;

const testResult = {
  credentialId: 'glm',
  ok: false,
  code: 'consent_required',
  message: 'Confirm to send it.',
  spent: 'nothing',
  at: INSTANT,
} as const;

/** A provider quota reading (docs/provider-quotas.md): a 5-hour window, a key limit, money and spend. */
const providerReading = {
  source: 'openrouter-key',
  via: 'endpoint',
  windows: [
    { label: '5h', usedPercent: 40, resetsAt: LATER_INSTANT },
    { label: 'key', unit: 'usd', used: 4.2, limit: 10, usedPercent: 42 },
  ],
  balance: { amount: 5.8, currency: 'USD' },
  spend: { amountUsd: 3.1, since: INSTANT, sessions: 4, unpriced: 1 },
  exhausted: false,
  unverified: false,
  note: 'Read from the provider.',
  at: INSTANT,
} as const;

const PROVIDER_QUOTA_CASES: readonly SchemaCase[] = [
  { name: 'ProviderQuotaWindowSchema', schema: credentials.ProviderQuotaWindowSchema, value: { label: 'week' } },
  {
    name: 'ProviderQuotaBalanceSchema',
    schema: credentials.ProviderQuotaBalanceSchema,
    value: providerReading.balance,
  },
  { name: 'ProviderQuotaSpendSchema', schema: credentials.ProviderQuotaSpendSchema, value: providerReading.spend },
  { name: 'ProviderQuotaReadingSchema', schema: credentials.ProviderQuotaReadingSchema, value: providerReading },
];

/** The environment-login half of the contract (docs/provider-presets.md). */
const ENVIRONMENT_CASES: readonly SchemaCase[] = [
  { name: 'ProviderQuotaSourceSchema', schema: credentials.ProviderQuotaSourceSchema, value: 'deepseek-balance' },
  { name: 'CloudCredentialKindSchema', schema: credentials.CloudCredentialKindSchema, value: 'gcloud-adc' },
  {
    name: 'LoginEnvironmentVariableSchema',
    schema: credentials.LoginEnvironmentVariableSchema,
    value: environment.variables[1],
  },
  {
    name: 'LoginCloudCredentialViewSchema',
    schema: credentials.LoginCloudCredentialViewSchema,
    value: environment.cloudCredential,
  },
  {
    name: 'LoginTestActSchema',
    schema: credentials.LoginTestActSchema,
    value: { available: false, reason: 'Needs request signing.' },
  },
  {
    name: 'LoginEnvironmentSchema',
    schema: credentials.LoginEnvironmentSchema,
    value: environment,
  },
  {
    name: 'LoginTestRequestSchema',
    schema: credentials.LoginTestRequestSchema,
    value: { allowInference: true },
  },
  { name: 'LoginTestCodeSchema', schema: credentials.LoginTestCodeSchema, value: 'not_testable' },
  { name: 'LoginTestResultSchema', schema: credentials.LoginTestResultSchema, value: testResult },
  { name: 'PresetVariableSchema', schema: credentials.PresetVariableSchema, value: preset.variables[0] },
  { name: 'PresetGroupSchema', schema: credentials.PresetGroupSchema, value: 'self-hosted' },
  { name: 'PresetDetectSchema', schema: credentials.PresetDetectSchema, value: detect },
  { name: 'ProviderPresetViewSchema', schema: credentials.ProviderPresetViewSchema, value: preset },
  {
    name: 'ProviderPresetCatalogSchema',
    schema: credentials.ProviderPresetCatalogSchema,
    value: { presets: [preset] },
  },
];

const budgetPeriod = {
  trigger: 40,
  hard: 60,
  spentUsd: 41.2,
  level: 'over_trigger',
  startsAt: INSTANT,
  resetsAt: LATER_INSTANT,
} as const;

const budget = {
  timeZone: 'America/Los_Angeles',
  timeZoneSet: true,
  daily: budgetPeriod,
  weekly: { hard: 200, spentUsd: 41.2, level: 'ok', startsAt: INSTANT, resetsAt: LATER_INSTANT },
  level: 'over_trigger',
  unpriced: 0,
  measured: true,
} as const;

const cases: readonly SchemaCase[] = [
  { name: 'LoginBudgetLevelSchema', schema: credentials.LoginBudgetLevelSchema, value: 'over_hard' },
  { name: 'LoginBudgetPeriodViewSchema', schema: credentials.LoginBudgetPeriodViewSchema, value: budgetPeriod },
  { name: 'LoginBudgetSchema', schema: credentials.LoginBudgetSchema, value: budget },
  {
    name: 'LoginViewSchema with a budget',
    schema: credentials.LoginViewSchema,
    value: { ...view, budget },
  },
  { name: 'LoginIdSchema', schema: credentials.LoginIdSchema, value: 'claude-work' },
  { name: 'LoginStatusWordSchema', schema: credentials.LoginStatusWordSchema, value: 'checking' },
  {
    name: 'LoginStatusReasonSchema',
    schema: credentials.LoginStatusReasonSchema,
    value: 'refresh_revoked',
  },
  { name: 'LoginStoreSchema', schema: credentials.LoginStoreSchema, value: 'ferretry' },
  {
    name: 'LoginStatusSchema',
    schema: credentials.LoginStatusSchema,
    value: { ...status, planType: 'pro' },
  },
  { name: 'LoginUsageWindowSchema', schema: credentials.LoginUsageWindowSchema, value: {} },
  { name: 'LoginUsageSchema', schema: credentials.LoginUsageSchema, value: usage },
  {
    name: 'LoginActSchema',
    schema: credentials.LoginActSchema,
    value: { available: false, reason: 'Nothing to check.' },
  },
  { name: 'LoginSignOutSchema', schema: credentials.LoginSignOutSchema, value: view.signOut },
  {
    name: 'LoginDisabledSchema',
    schema: credentials.LoginDisabledSchema,
    value: { reason: 'spend limit', until: INSTANT, source: 'login' },
  },
  { name: 'LoginViewSchema', schema: credentials.LoginViewSchema, value: view },
  {
    name: 'LoginViewSchema switched off',
    schema: credentials.LoginViewSchema,
    value: { ...view, disabled: { until: INSTANT, source: 'login' } },
  },
  {
    name: 'LoginListSchema',
    schema: credentials.LoginListSchema,
    value: { format: 2, machine: 'studio', credentials: [view] },
  },
  {
    name: 'LoginCheckRequestSchema',
    schema: credentials.LoginCheckRequestSchema,
    value: {},
  },
  ...ENVIRONMENT_CASES,
  ...PROVIDER_QUOTA_CASES,
  {
    name: 'LoginUsageSchema with a provider reading',
    schema: credentials.LoginUsageSchema,
    value: { fiveHour: {}, weekly: {}, source: 'provider-quota', at: INSTANT, provider: providerReading },
  },
];

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('the credential wire contract', () => {
  it('should round-trip every shape a browser reads and every request it may send', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(credentials, cases);
  });

  it('should have nowhere to put a token or a digest', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a view carrying an access token', credentials.LoginViewSchema, {
        ...view,
        accessToken: 'sk-ant-oat01-fake',
      }),
      rejects('a status carrying a digest', credentials.LoginStatusSchema, {
        ...status,
        fingerprint: 'sha256:fake',
      }),
      rejects('a usage window carrying a bearer', credentials.LoginUsageWindowSchema, {
        bearer: 'fake',
      }),
      rejects('a check request carrying a refresh token', credentials.LoginCheckRequestSchema, {
        refreshToken: 'fake',
      }),
      rejects('a check request still carrying a confirmation', credentials.LoginCheckRequestSchema, {
        operatorPassword: 'fake',
      }),
    ]);
  });

  it('should refuse a fifth status word, an unknown format and an id that is not a slug', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a fifth word', credentials.LoginStatusWordSchema, 'unknown'),
      rejects('a version-3 document', credentials.LoginListSchema, {
        format: 3,
        machine: 'studio',
        credentials: [],
      }),
      rejects('an id with spaces', credentials.LoginIdSchema, 'Claude Work'),
      rejects('an id that is too long', credentials.LoginIdSchema, `a${'b'.repeat(64)}`),
      rejects('a negative percentage', credentials.LoginUsageWindowSchema, { usedPercent: -1 }),
      rejects('an unavailable act with no reason', credentials.LoginActSchema, { available: false }),
    ]);
  });

  it('should read a window nobody measured as unknown rather than zero', () => {
    // Act
    const parsed = credentials.LoginUsageSchema.parse({ fiveHour: {}, weekly: {} });

    // Assert
    should(parsed.fiveHour).not.have.property('usedPercent');
    should(parsed).not.have.property('source');
  });
});

describe('the environment-login wire contract (docs/provider-presets.md)', () => {
  it('should carry a login row with its environment, and refuse a secret value anywhere in it', () => {
    // Act
    const parsed = credentials.LoginViewSchema.parse({ ...view, store: 'environment', environment });

    // Assert
    should(parsed.environment?.variables[1]).deepEqual({
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secrets: ['ZAI_API_KEY'],
      set: true,
    });
    assertRejects([
      rejects('a secret variable carrying its value', credentials.LoginEnvironmentVariableSchema, {
        ...environment.variables[1],
        value: 'sk-fake',
      }),
      rejects('a hidden variable carrying its value', credentials.LoginEnvironmentVariableSchema, {
        name: 'PASTED',
        kind: 'hidden',
        value: 'sk-fake',
      }),
      rejects('a test request carrying a key', credentials.LoginTestRequestSchema, { key: 'sk-fake' }),
      rejects('a test result carrying the reply', credentials.LoginTestResultSchema, {
        ...testResult,
        body: '{}',
      }),
      rejects('a preset variable carrying a secret value', credentials.PresetVariableSchema, {
        ...preset.variables[1],
        value: 'sk-fake',
        extra: true,
      }),
    ]);
  });

  it('should name the presets route', () => {
    should(credentials.FLEET_PRESETS_PATH).equal('/v1/fleet/presets');
  });

  it('should carry a credential’s every driven CLI, Claude Code first, and parse without it from an older daemon', () => {
    // Act
    const dual = credentials.LoginViewSchema.parse({ ...view, harnesses: ['claude', 'codex'] });
    const legacy = credentials.LoginViewSchema.parse({ ...view, harnesses: undefined });

    // Assert
    should(dual.harnesses).deepEqual(['claude', 'codex']);
    should(legacy.harnesses).be.undefined();
  });

  it('should carry a dual preset’s halves, its detection clues and its grid group, and parse without any from an older daemon', () => {
    // Act
    const parsed = credentials.ProviderPresetViewSchema.parse(preset);
    const legacy = credentials.ProviderPresetViewSchema.parse({
      ...preset,
      halves: undefined,
      detect: undefined,
      group: undefined,
    });

    // Assert
    should(parsed.halves).deepEqual(preset.halves);
    should(parsed.detect).deepEqual(detect);
    should(legacy.halves).be.undefined();
    should(legacy.detect).be.undefined();
    should(parsed.group).equal('popular');
    should(legacy.group).be.undefined();
  });

  it('should name which half a variable belongs to, absent meaning shared by every half', () => {
    // Act
    const halved = credentials.LoginEnvironmentVariableSchema.parse({
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.openrouter.ai',
      harness: 'claude',
    });
    const shared = credentials.LoginEnvironmentVariableSchema.parse({ name: 'SHARED', kind: 'plain', value: 'x' });

    // Assert
    should(halved).containDeep({ harness: 'claude' });
    should(shared).not.have.property('harness');
  });
});

describe('the provider quota wire contract (docs/provider-quotas.md)', () => {
  it('should refuse a currency that is not a code, a negative share and a window it does not know', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a currency symbol', credentials.ProviderQuotaBalanceSchema, { amount: 1, currency: '$' }),
      rejects('a negative share', credentials.ProviderQuotaWindowSchema, { label: '5h', usedPercent: -1 }),
      rejects('an unknown window', credentials.ProviderQuotaWindowSchema, { label: 'day' }),
      rejects('a reading carrying the key', credentials.ProviderQuotaReadingSchema, {
        source: 'deepseek-balance',
        via: 'endpoint',
        windows: [],
        exhausted: false,
        unverified: false,
        at: INSTANT,
        key: 'sk-fake',
      }),
    ]);
  });

  it('should read a window the provider did not measure as unknown rather than zero', () => {
    // Act
    const parsed = credentials.ProviderQuotaWindowSchema.parse({ label: '5h' });

    // Assert
    should(parsed).deepEqual({ label: '5h' });
  });
});
