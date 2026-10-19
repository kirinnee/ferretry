/**
 * The wire shape of importing existing CLI conversations as ferrets: a metadata-only listing and an
 * adoption that names conversations by the CLI's own id.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as imports from '../../src/lib/conversation-import.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ID = '0c7a6f2e-1b2d-4c3e-9f00-112233445566';
const row = {
  id: ID,
  harness: 'claude',
  project: '/work/app',
  preview: 'Fix the login page',
  lastActivityAt: INSTANT,
  turns: 4,
  model: 'claude-sonnet-4-5',
};
const request = { harness: 'claude', runtime: 'claude-default', conversations: [{ id: ID, start: true }] };

const cases: SchemaCase[] = [
  { name: 'ImportConversationIdSchema', schema: imports.ImportConversationIdSchema, value: ID },
  { name: 'ImportableConversationSchema', schema: imports.ImportableConversationSchema, value: row },
  {
    name: 'ConversationImportListingSchema',
    schema: imports.ConversationImportListingSchema,
    value: { conversations: [row, { ...row, id: 'b', latest: 'Ship it', adoptedBy: 's-1' }], matched: 2, skipped: 1 },
  },
  {
    name: 'ConversationImportQuerySchema',
    schema: imports.ConversationImportQuerySchema,
    value: { source: 'ferretry', harness: 'codex', q: 'login', since: INSTANT, limit: 20 },
  },
  { name: 'ConversationSourceSchema', schema: imports.ConversationSourceSchema, value: 'computer' },
  {
    name: 'ConversationExchangeMessageSchema',
    schema: imports.ConversationExchangeMessageSchema,
    value: { role: 'assistant', text: 'Fixed it.' },
  },
  {
    name: 'ConversationPreviewSchema',
    schema: imports.ConversationPreviewSchema,
    value: { id: ID, harness: 'claude', messages: [{ role: 'user', text: 'Fix the login page' }] },
  },
  { name: 'ConversationAdoptItemSchema', schema: imports.ConversationAdoptItemSchema, value: { id: ID, start: false } },
  { name: 'ConversationAdoptRequestSchema', schema: imports.ConversationAdoptRequestSchema, value: request },
  { name: 'ConversationAdoptRefusalCodeSchema', schema: imports.ConversationAdoptRefusalCodeSchema, value: 'conflict' },
  {
    name: 'ConversationAdoptedSchema',
    schema: imports.ConversationAdoptedSchema,
    value: { id: ID, session: 's-1', name: 'Mika', status: 'stopped' },
  },
  {
    name: 'ConversationAdoptRefusedSchema',
    schema: imports.ConversationAdoptRefusedSchema,
    value: { id: ID, code: 'already_adopted', reason: 'Mika already keeps this conversation.' },
  },
  {
    name: 'ConversationAdoptResultSchema',
    schema: imports.ConversationAdoptResultSchema,
    value: { adopted: [], refused: [] },
  },
];

describe('the conversation import wire contract', () => {
  it('should round-trip every shape and cover every schema', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(imports, cases);
  });

  it('should read a limit from its URL text', () => {
    // Act
    const parsed = imports.ConversationImportQuerySchema.parse({ limit: '20' });

    // Assert
    should(parsed.limit).equal(20);
  });

  it('should default an item to adopting it stopped', () => {
    // Act
    const parsed = imports.ConversationAdoptItemSchema.parse({ id: ID });

    // Assert
    should(parsed.start).be.false();
  });

  it('should refuse a path-shaped id, a long preview, a repeated id and a launch burst', () => {
    // Arrange
    const burst = Array.from({ length: imports.CONVERSATION_LAUNCH_MAX + 1 }, (_, index) => ({
      id: `c${index}`,
      start: true,
    }));

    // Act & Assert
    assertRejects([
      { name: 'path id', schema: imports.ImportConversationIdSchema, value: '../etc' },
      {
        name: 'long preview',
        schema: imports.ImportableConversationSchema,
        value: { ...row, preview: 'x'.repeat(imports.CONVERSATION_PREVIEW_MAX + 1) },
      },
      {
        name: 'repeated',
        schema: imports.ConversationAdoptRequestSchema,
        value: { ...request, conversations: [{ id: ID }, { id: ID }] },
      },
      {
        name: 'burst',
        schema: imports.ConversationAdoptRequestSchema,
        value: { ...request, conversations: burst },
      },
      { name: 'empty', schema: imports.ConversationAdoptRequestSchema, value: { ...request, conversations: [] } },
      { name: 'unknown source', schema: imports.ConversationImportQuerySchema, value: { source: 'home' } },
      {
        name: 'long exchange',
        schema: imports.ConversationExchangeMessageSchema,
        value: { role: 'user', text: 'x'.repeat(imports.CONVERSATION_EXCHANGE_TEXT_MAX + 1) },
      },
      { name: 'tool exchange', schema: imports.ConversationExchangeMessageSchema, value: { role: 'tool', text: 'x' } },
    ]);
  });
});
