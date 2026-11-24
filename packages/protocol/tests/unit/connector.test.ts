import { describe, it } from 'bun:test';
import should from 'should';
import * as connector from '../../src/lib/connector.ts';
import * as stepUp from '../../src/lib/step-up.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const pending = {
  id: 'cr_k7q2mfabcd',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: INSTANT,
  expiresAt: LATER_INSTANT,
};
const grant = {
  id: 'cg_k7q2mfabcd',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read'],
  createdAt: INSTANT,
  approvedBy: 'admin-cli',
  lastUsedAt: LATER_INSTANT,
};

const cases: SchemaCase[] = [
  { name: 'scope', schema: connector.ConnectorScopeSchema, value: 'fleet:write' },
  { name: 'request id', schema: connector.ConnectorRequestIdSchema, value: pending.id },
  { name: 'grant id', schema: connector.ConnectorGrantIdSchema, value: grant.id },
  { name: 'match code', schema: connector.ConnectorMatchCodeSchema, value: 'K7Q-2MF' },
  { name: 'request reference typed by hand', schema: connector.ConnectorRequestRefSchema, value: '  k7q2mf ' },
  { name: 'pending view', schema: connector.ConnectorPendingViewSchema, value: pending },
  { name: 'grant view', schema: connector.ConnectorGrantViewSchema, value: grant },
  {
    name: 'revoked grant view',
    schema: connector.ConnectorGrantViewSchema,
    value: { ...grant, revokedAt: LATER_INSTANT },
  },
  {
    name: 'status when on',
    schema: connector.ConnectorStatusSchema,
    value: {
      enabled: true,
      publicUrl: 'https://mcp.example.test',
      mcpUrl: 'https://mcp.example.test/mcp',
      pending: [pending],
      grants: [grant],
    },
  },
  {
    name: 'status when off',
    schema: connector.ConnectorStatusSchema,
    value: { enabled: false, disabledReason: 'Set connector.enabled in config/daemon.json.', pending: [], grants: [] },
  },
  { name: 'act body', schema: connector.ConnectorActRequestSchema, value: {} },
];

describe('connector wire schemas', () => {
  it('should round-trip every document', () => {
    assertRoundTrips(cases);
  });

  it('should leave no schema without a case', () => {
    assertCoversEverySchema(connector, cases);
  });

  it('should refuse a field no view may carry: a token, a code, a handle or a digest', () => {
    // A strict schema is how the connector's one rule (nothing secret leaves in a view) is held on the wire.
    assertRejects([
      { name: 'grant with a token', schema: connector.ConnectorGrantViewSchema, value: { ...grant, accessToken: 'x' } },
      {
        name: 'grant with a digest',
        schema: connector.ConnectorGrantViewSchema,
        value: { ...grant, tokenDigest: 'x' },
      },
      {
        name: 'pending with a handle',
        schema: connector.ConnectorPendingViewSchema,
        value: { ...pending, handle: 'x' },
      },
      { name: 'pending with a code', schema: connector.ConnectorPendingViewSchema, value: { ...pending, code: 'x' } },
      {
        name: 'status with a field of its own',
        schema: connector.ConnectorStatusSchema,
        value: { enabled: false, pending: [], grants: [], secret: 'x' },
      },
      {
        name: 'an act that names its own actor',
        schema: connector.ConnectorActRequestSchema,
        value: { approvedBy: 'me' },
      },
    ]);
  });

  it('should refuse shapes that are not ids, codes, scopes or instants', () => {
    assertRejects([
      { name: 'grant id as request id', schema: connector.ConnectorRequestIdSchema, value: grant.id },
      { name: 'request id as grant id', schema: connector.ConnectorGrantIdSchema, value: pending.id },
      { name: 'lowercase match code', schema: connector.ConnectorMatchCodeSchema, value: 'k7q-2mf' },
      { name: 'match code without its hyphen', schema: connector.ConnectorMatchCodeSchema, value: 'K7Q2MF' },
      { name: 'a path as a reference', schema: connector.ConnectorRequestRefSchema, value: '../approve' },
      { name: 'an unbounded reference', schema: connector.ConnectorRequestRefSchema, value: 'a'.repeat(33) },
      { name: 'an unknown scope', schema: connector.ConnectorScopeSchema, value: 'fleet:admin' },
      { name: 'no scopes', schema: connector.ConnectorPendingViewSchema, value: { ...pending, scopes: [] } },
      {
        name: 'a date, not an instant',
        schema: connector.ConnectorGrantViewSchema,
        value: { ...grant, createdAt: 'yesterday' },
      },
    ]);
  });
});

describe('the approve-connector step-up act', () => {
  it('should be a known act, skippable at the machine and never one asked of every caller', () => {
    // Assert
    should(stepUp.StepUpActSchema.safeParse('approve-connector').success).be.true();
    should(stepUp.STEP_UP_ACTS.approveConnector).equal('approve-connector');
    should(stepUp.stepUpSkippableAtMachine('approve-connector')).be.true();
    should(stepUp.stepUpKeepsProof('approve-connector')).be.false();
    should(stepUp.STEP_UP_ACTS_EVERY_CALLER as readonly string[]).not.containEql('approve-connector');
  });

  it('should take a step-up request for it with no subject, and refuse one that carries a subject', () => {
    // Arrange
    const origin = 'https://app.ferretry.test';

    // Act + Assert
    should(stepUp.StepUpOptionsRequestSchema.safeParse({ origin, act: 'approve-connector' }).success).be.true();
    should(
      stepUp.StepUpOptionsRequestSchema.safeParse({
        origin,
        act: 'approve-connector',
        subject: `prs_${'a'.repeat(24)}`,
      }).success,
    ).be.false();
  });
});
