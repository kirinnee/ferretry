import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { ProtocolImportGateway } from '../../../src/lib/import/ports.ts';
import { conversation, listing } from './fixtures.ts';

interface Sent {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A client that answers each path with a canned body, parsed through the schema the gateway gave. */
function client(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  return {
    sent,
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      sent.push({ path, init });
      return schema.parse(answers[path]);
    },
  };
}

const body = (sent: Sent | undefined): unknown => JSON.parse(String(sent?.init?.body));
const headers = (sent: Sent | undefined): Record<string, string> =>
  (sent?.init?.headers ?? {}) as Record<string, string>;

describe('ProtocolImportGateway.list', () => {
  it('should call the bare path with no query string when nothing narrows it', async () => {
    // Arrange
    const row = conversation();
    const fake = client({ '/v1/imports/conversations': listing([row]) });
    const gateway = new ProtocolImportGateway(fake);

    // Act
    const result = await gateway.list();

    // Assert
    should(fake.sent.map(sent => sent.path)).eql(['/v1/imports/conversations']);
    should(result).eql(listing([row]));
  });

  it('should carry only the query fields given, in the standard URL grammar', async () => {
    // Arrange
    const fake = client({
      '/v1/imports/conversations?source=ferretry&harness=claude&q=login+bug&since=2026-10-10T00%3A00%3A00.000Z&limit=20':
        listing([]),
    });
    const gateway = new ProtocolImportGateway(fake);

    // Act
    await gateway.list({
      source: 'ferretry',
      harness: 'claude',
      q: 'login bug',
      since: '2026-10-10T00:00:00.000Z',
      limit: 20,
    });

    // Assert
    should(fake.sent[0]?.path).equal(
      '/v1/imports/conversations?source=ferretry&harness=claude&q=login+bug&since=2026-10-10T00%3A00%3A00.000Z&limit=20',
    );
  });

  it('should ask for the synced listing by name', async () => {
    // Arrange
    const fake = client({ '/v1/imports/conversations?source=synced&limit=20': listing([]) });
    const gateway = new ProtocolImportGateway(fake);

    // Act
    await gateway.list({ source: 'synced', limit: 20 });

    // Assert
    should(fake.sent[0]?.path).equal('/v1/imports/conversations?source=synced&limit=20');
  });

  it('should omit an empty query word', async () => {
    // Arrange
    const fake = client({ '/v1/imports/conversations': listing([]) });
    const gateway = new ProtocolImportGateway(fake);

    // Act
    await gateway.list({ q: '' });

    // Assert
    should(fake.sent[0]?.path).equal('/v1/imports/conversations');
  });
});

describe('ProtocolImportGateway.adopt', () => {
  it('should POST the parsed request body as JSON', async () => {
    // Arrange
    const fake = client({
      '/v1/imports/conversations/adopt': {
        adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
        refused: [],
      },
    });
    const gateway = new ProtocolImportGateway(fake);

    // Act
    const result = await gateway.adopt({
      harness: 'claude',
      runtime: 'claude-work',
      conversations: [{ id: 'c-1', start: true }],
    });

    // Assert
    should(fake.sent[0]?.init).have.property('method', 'POST');
    should(body(fake.sent[0])).eql({
      harness: 'claude',
      runtime: 'claude-work',
      conversations: [{ id: 'c-1', start: true }],
    });
    should(headers(fake.sent[0])).eql({ 'content-type': 'application/json' });
    should(result.adopted[0]?.session).equal('s-1');
  });

  it('should reject a request the shared schema refuses before ever sending it', async () => {
    // Arrange
    const fake = client({});
    const gateway = new ProtocolImportGateway(fake);

    // Act + Assert
    await should(gateway.adopt({ harness: 'claude', runtime: 'work', conversations: [] })).be.rejected();
    should(fake.sent).be.empty();
  });
});
