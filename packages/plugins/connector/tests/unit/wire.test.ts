import { describe, it } from 'bun:test';
import * as connector from '../../contract/wire.ts';
const INSTANT = '2026-11-24T10:00:00.000Z';
const LATER_INSTANT = '2026-11-24T10:10:00.000Z';
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
      switchedOn: true,
      publicUrlSource: 'tunnel',
      publicUrl: 'https://mcp.example.test',
      mcpUrl: 'https://mcp.example.test/mcp',
      pending: [pending],
      grants: [grant],
    },
  },
  {
    name: 'status when off',
    schema: connector.ConnectorStatusSchema,
    value: {
      enabled: false,
      switchedOn: false,
      disabledReason: 'Switch it on in the app.',
      pending: [],
      grants: [],
    },
  },
  {
    name: 'status when on but waiting for the tunnel',
    schema: connector.ConnectorStatusSchema,
    value: {
      enabled: false,
      switchedOn: true,
      disabledReason: 'Waiting for the tunnel.',
      pending: [],
      grants: [],
    },
  },
  { name: 'act body', schema: connector.ConnectorActRequestSchema, value: {} },
  { name: 'switch body', schema: connector.ConnectorChangeSchema, value: { enabled: true } },
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

  it('should refuse a switch that names anything but on or off, and a status that does not say whether it is switched on', () => {
    assertRejects([
      {
        name: 'switch with an address',
        schema: connector.ConnectorChangeSchema,
        value: { enabled: true, publicUrl: 'https://x.example' },
      },
      { name: 'switch with no answer', schema: connector.ConnectorChangeSchema, value: {} },
      { name: 'switch as a word', schema: connector.ConnectorChangeSchema, value: { enabled: 'yes' } },
      {
        name: 'status without switchedOn',
        schema: connector.ConnectorStatusSchema,
        value: { enabled: false, pending: [], grants: [] },
      },
      {
        name: 'status with an unknown address source',
        schema: connector.ConnectorStatusSchema,
        value: { enabled: true, switchedOn: true, publicUrlSource: 'guess', pending: [], grants: [] },
      },
    ]);
  });
});
