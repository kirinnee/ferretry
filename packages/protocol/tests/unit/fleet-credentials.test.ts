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
  { name: 'FleetCredentialViewSchema', schema: credentials.FleetCredentialViewSchema, value: view },
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
