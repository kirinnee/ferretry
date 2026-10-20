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
  {
    name: 'ImportableConversationSchema',
    schema: imports.ImportableConversationSchema,
    value: { ...row, name: 'Login page fix' },
  },
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
      {
        name: 'long name',
        schema: imports.ImportableConversationSchema,
        value: { ...row, name: 'x'.repeat(imports.CONVERSATION_NAME_MAX + 1) },
      },
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

describe('conversation import windows', () => {
  const NOW = Date.parse('2026-10-19T12:00:00Z');
  const at = (id: string, daysAgo: number, adoptedBy?: string): imports.ImportableConversation => ({
    ...row,
    harness: 'claude' as const,
    id,
    lastActivityAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    ...(adoptedBy === undefined ? {} : { adoptedBy }),
  });

  it('parseImportWindow takes only the offered windows', () => {
    should(imports.parseImportWindow('7d')).equal(7);
    should(imports.parseImportWindow(' 30d ')).equal(30);
    should(imports.parseImportWindow('2d')).equal(undefined);
    should(imports.parseImportWindow('7h')).equal(undefined);
  });

  it('conversationsToImport keeps un-owned rows inside the window; undefined means all', () => {
    const rows = [at('a', 0.5), at('b', 2), at('c', 20), at('d', 0.1, 'owned')];
    should(imports.conversationsToImport(rows, 1, NOW)).eql(['a']);
    should(imports.conversationsToImport(rows, 3, NOW)).eql(['a', 'b']);
    should(imports.conversationsToImport(rows, undefined, NOW)).eql(['a', 'b', 'c']);
  });

  it('adoptionBatches splits at the adoption cap', () => {
    const ids = Array.from({ length: imports.CONVERSATION_ADOPT_MAX * 2 + 1 }, (_, index) => `id${index}`);
    should(imports.adoptionBatches(ids).map(batch => batch.length)).eql([
      imports.CONVERSATION_ADOPT_MAX,
      imports.CONVERSATION_ADOPT_MAX,
      1,
    ]);
    should(imports.adoptionBatches([])).eql([]);
  });
});

describe('a conversation’s folder as a row names it', () => {
  it('is the folder’s own name, never a path', () => {
    should(imports.conversationFolder('/work/api/services/billing')).eql({ name: 'billing', scratch: false });
    should(imports.conversationFolder('/shop/')).eql({ name: 'shop', scratch: false });
    should(imports.conversationFolder('C:\\work\\shop')).eql({ name: 'shop', scratch: false });
    should(imports.conversationFolder('/')).eql({ name: '/', scratch: false });
    should(imports.conversationFolder('')).eql({ name: undefined, scratch: false });
  });

  it('marks a temp or scratch folder scratch, naming it only by a name a person chose', () => {
    should(
      imports.conversationFolder(
        '/tmp/claude-1000/-home-owner-work-shop/d711c5af-2c1e-4b7a-9d3e-0f6a1b2c3d4e/scratchpad',
      ),
    ).eql({ name: undefined, scratch: true });
    should(imports.conversationFolder('/tmp/claude-1000/wt-cart')).eql({ name: 'wt-cart', scratch: true });
    should(imports.conversationFolder('/private/var/folders/x1/T/0123456789abcdef')).eql({
      name: undefined,
      scratch: true,
    });
    should(imports.conversationFolder('/tmp')).eql({ name: 'tmp', scratch: true });
    should(imports.conversationFolder('/home/owner/notes/scratch')).eql({ name: undefined, scratch: true });
    should(imports.conversationFolder('/home/owner/Scratch/ideas')).eql({ name: 'ideas', scratch: true });
    should(imports.conversationFolder('/home/owner/tmpfiles')).eql({ name: 'tmpfiles', scratch: false });
  });
});
