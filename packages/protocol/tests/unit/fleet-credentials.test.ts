/**
 * The wire shape of an account-model credential: status and usage, never material.
 *
 * Every object is strict, so a token, a refresh token or a digest would have to arrive as an extra
 * field — and is REFUSED rather than stripped. The cases below are that property, not trivia.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as credentials from '../../src/lib/fleet-credentials.ts';
import type { FleetCredentialView } from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

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
} satisfies FleetCredentialView;

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
    name: 'FleetEnvironmentVariableSchema',
    schema: credentials.FleetEnvironmentVariableSchema,
    value: environment.variables[1],
  },
  {
    name: 'FleetCloudCredentialViewSchema',
    schema: credentials.FleetCloudCredentialViewSchema,
    value: environment.cloudCredential,
  },
  {
    name: 'FleetCredentialTestActSchema',
    schema: credentials.FleetCredentialTestActSchema,
    value: { available: false, reason: 'Needs request signing.' },
  },
  {
    name: 'FleetCredentialEnvironmentSchema',
    schema: credentials.FleetCredentialEnvironmentSchema,
    value: environment,
  },
  {
    name: 'FleetCredentialTestRequestSchema',
    schema: credentials.FleetCredentialTestRequestSchema,
    value: { allowInference: true },
  },
  { name: 'FleetCredentialTestCodeSchema', schema: credentials.FleetCredentialTestCodeSchema, value: 'not_testable' },
  { name: 'FleetCredentialTestResultSchema', schema: credentials.FleetCredentialTestResultSchema, value: testResult },
  { name: 'FleetPresetVariableSchema', schema: credentials.FleetPresetVariableSchema, value: preset.variables[0] },
  { name: 'FleetPresetGroupSchema', schema: credentials.FleetPresetGroupSchema, value: 'self-hosted' },
  { name: 'FleetPresetDetectSchema', schema: credentials.FleetPresetDetectSchema, value: detect },
  { name: 'FleetProviderPresetViewSchema', schema: credentials.FleetProviderPresetViewSchema, value: preset },
  {
    name: 'FleetProviderPresetCatalogSchema',
    schema: credentials.FleetProviderPresetCatalogSchema,
    value: { presets: [preset] },
  },
];

const cases: readonly SchemaCase[] = [
  { name: 'FleetCredentialIdSchema', schema: credentials.FleetCredentialIdSchema, value: 'claude-work' },
  { name: 'FleetCredentialStatusWordSchema', schema: credentials.FleetCredentialStatusWordSchema, value: 'checking' },
  {
    name: 'FleetCredentialStatusReasonSchema',
    schema: credentials.FleetCredentialStatusReasonSchema,
    value: 'refresh_revoked',
  },
  { name: 'FleetCredentialStoreSchema', schema: credentials.FleetCredentialStoreSchema, value: 'ferretry' },
  {
    name: 'FleetCredentialStatusSchema',
    schema: credentials.FleetCredentialStatusSchema,
    value: { ...status, planType: 'pro' },
  },
  { name: 'FleetCredentialUsageWindowSchema', schema: credentials.FleetCredentialUsageWindowSchema, value: {} },
  { name: 'FleetCredentialUsageSchema', schema: credentials.FleetCredentialUsageSchema, value: usage },
  {
    name: 'FleetCredentialActSchema',
    schema: credentials.FleetCredentialActSchema,
    value: { available: false, reason: 'Nothing to check.' },
  },
  { name: 'FleetCredentialSignOutSchema', schema: credentials.FleetCredentialSignOutSchema, value: view.signOut },
  {
    name: 'FleetDisabledSchema',
    schema: credentials.FleetDisabledSchema,
    value: { reason: 'spend limit', until: INSTANT, source: 'login' },
  },
  { name: 'FleetCredentialViewSchema', schema: credentials.FleetCredentialViewSchema, value: view },
  {
    name: 'FleetCredentialViewSchema switched off',
    schema: credentials.FleetCredentialViewSchema,
    value: { ...view, disabled: { until: INSTANT, source: 'login' } },
  },
  {
    name: 'FleetCredentialListSchema',
    schema: credentials.FleetCredentialListSchema,
    value: { format: 2, machine: 'studio', credentials: [view] },
  },
  {
    name: 'FleetCredentialCheckRequestSchema',
    schema: credentials.FleetCredentialCheckRequestSchema,
    value: {},
  },
  ...ENVIRONMENT_CASES,
  ...PROVIDER_QUOTA_CASES,
  {
    name: 'FleetCredentialUsageSchema with a provider reading',
    schema: credentials.FleetCredentialUsageSchema,
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
      rejects('a view carrying an access token', credentials.FleetCredentialViewSchema, {
        ...view,
        accessToken: 'sk-ant-oat01-fake',
      }),
      rejects('a status carrying a digest', credentials.FleetCredentialStatusSchema, {
        ...status,
        fingerprint: 'sha256:fake',
      }),
      rejects('a usage window carrying a bearer', credentials.FleetCredentialUsageWindowSchema, {
        bearer: 'fake',
      }),
      rejects('a check request carrying a refresh token', credentials.FleetCredentialCheckRequestSchema, {
        refreshToken: 'fake',
      }),
      rejects('a check request still carrying a confirmation', credentials.FleetCredentialCheckRequestSchema, {
        operatorPassword: 'fake',
      }),
    ]);
  });

  it('should refuse a fifth status word, an unknown format and an id that is not a slug', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a fifth word', credentials.FleetCredentialStatusWordSchema, 'unknown'),
      rejects('a version-3 document', credentials.FleetCredentialListSchema, {
        format: 3,
        machine: 'studio',
        credentials: [],
      }),
      rejects('an id with spaces', credentials.FleetCredentialIdSchema, 'Claude Work'),
      rejects('an id that is too long', credentials.FleetCredentialIdSchema, `a${'b'.repeat(64)}`),
      rejects('a negative percentage', credentials.FleetCredentialUsageWindowSchema, { usedPercent: -1 }),
      rejects('an unavailable act with no reason', credentials.FleetCredentialActSchema, { available: false }),
    ]);
  });

  it('should read a window nobody measured as unknown rather than zero', () => {
    // Act
    const parsed = credentials.FleetCredentialUsageSchema.parse({ fiveHour: {}, weekly: {} });

    // Assert
    should(parsed.fiveHour).not.have.property('usedPercent');
    should(parsed).not.have.property('source');
  });
});

describe('the environment-login wire contract (docs/provider-presets.md)', () => {
  it('should carry a login row with its environment, and refuse a secret value anywhere in it', () => {
    // Act
    const parsed = credentials.FleetCredentialViewSchema.parse({ ...view, store: 'environment', environment });

    // Assert
    should(parsed.environment?.variables[1]).deepEqual({
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secrets: ['ZAI_API_KEY'],
      set: true,
    });
    assertRejects([
      rejects('a secret variable carrying its value', credentials.FleetEnvironmentVariableSchema, {
        ...environment.variables[1],
        value: 'sk-fake',
      }),
      rejects('a hidden variable carrying its value', credentials.FleetEnvironmentVariableSchema, {
        name: 'PASTED',
        kind: 'hidden',
        value: 'sk-fake',
      }),
      rejects('a test request carrying a key', credentials.FleetCredentialTestRequestSchema, { key: 'sk-fake' }),
      rejects('a test result carrying the reply', credentials.FleetCredentialTestResultSchema, {
        ...testResult,
        body: '{}',
      }),
      rejects('a preset variable carrying a secret value', credentials.FleetPresetVariableSchema, {
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
    const dual = credentials.FleetCredentialViewSchema.parse({ ...view, harnesses: ['claude', 'codex'] });
    const legacy = credentials.FleetCredentialViewSchema.parse({ ...view, harnesses: undefined });

    // Assert
    should(dual.harnesses).deepEqual(['claude', 'codex']);
    should(legacy.harnesses).be.undefined();
  });

  it('should carry a dual preset’s halves, its detection clues and its grid group, and parse without any from an older daemon', () => {
    // Act
    const parsed = credentials.FleetProviderPresetViewSchema.parse(preset);
    const legacy = credentials.FleetProviderPresetViewSchema.parse({
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
    const halved = credentials.FleetEnvironmentVariableSchema.parse({
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.openrouter.ai',
      harness: 'claude',
    });
    const shared = credentials.FleetEnvironmentVariableSchema.parse({ name: 'SHARED', kind: 'plain', value: 'x' });

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
