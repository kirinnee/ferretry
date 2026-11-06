import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaItemSchema, type AgendaItem } from '@ferretry/protocol';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import type { AgendaRollup } from '../../../../src/lib/agenda/index.ts';
import { agendaOpenRoutes } from '../../../../src/lib/runtime/mounts/agenda-open.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, fromFerret, human } from './support.ts';

function fixture(items: AgendaItem[] = []) {
  const reads: string[] = [];
  const rollup = {
    page: async (query: unknown) => {
      reads.push(`page:${JSON.stringify(query)}`);
      return {
        sessions: items.length === 0 ? [] : [{ sessionId: 's1', items }],
        ...((query as { after?: string }).after === 'a' ? { next: 'b' } : {}),
      };
    },
  } as unknown as AgendaRollup;
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaOpenRoutes(rollup)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const get = async (
    query: readonly (readonly [string, string])[] = [],
    headers: Readonly<Record<string, string>> = human,
  ): Promise<ApiResponse> =>
    await dispatcher.dispatch(request({ method: 'GET', path: '/v1/agenda/open', headers, query }));
  return { reads, get, dispatcher };
}

describe('GET /v1/agenda/open', () => {
  it('should send whole items', async () => {
    const item = AgendaItemSchema.parse({
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Report',
      why: 'Read it',
      waitingSince: '2026-11-03T08:00:00.000Z',
      howToResolve: 'Read',
      raisedBy: 'agent',
      raisedBySession: 's1',
      raisedByName: 'Ada',
      body: 'b'.repeat(50_000),
      whereWeAre: 'Ready',
    });
    const { get } = fixture([item]);
    const response = await get();
    const items = (jsonBody(response).sessions as { items: AgendaItem[] }[])[0]?.items;
    should(items?.[0]?.body).have.length(50_000);
    should(items?.[0]?.whereWeAre).equal('Ready');
  });
  it('should answer the owner a page, with the query read from the URL', async () => {
    // Arrange
    const { reads, get } = fixture();

    // Act
    const response = await get([
      ['after', 'a'],
      ['limit', '50'],
    ]);

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessions: [], next: 'b' });
    should(reads).deepEqual(['page:{"after":"a","limit":50}']);
  });

  it('should take an absent or empty query as the first page', async () => {
    // Arrange
    const { reads, get } = fixture();

    // Act
    const response = await get([
      ['after', ''],
      ['limit', ''],
    ]);

    // Assert
    should(response.status).equal(200);
    should(reads).deepEqual(['page:{}']);
  });

  it('should refuse a limit that is not a whole number in range, and a cursor that is not an id', async () => {
    // Arrange
    const { reads, get } = fixture();

    // Act
    const words = await get([['limit', 'many']]);
    const zero = await get([['limit', '0']]);
    const huge = await get([['limit', '100000']]);
    const long = await get([['after', 'x'.repeat(200)]]);

    // Assert
    should([words.status, zero.status, huge.status, long.status]).deepEqual([400, 400, 400, 400]);
    should(jsonBody(words).code).equal('invalid');
    should(reads).deepEqual([]);
  });

  it('should refuse a ferret’s credential: the roll-up names every conversation, which no ferret needs', async () => {
    // Arrange
    const { reads, get, dispatcher } = fixture();

    // Act — on the admin token naming its session, and on its own session credential.
    const named = await get([], agentIn('s1'));
    const own = await dispatcher.dispatch(
      fromFerret(request({ method: 'GET', path: '/v1/agenda/open', headers: human })),
    );

    // Assert
    should(named.status).equal(403);
    should([own.status, jsonBody(own).code]).deepEqual([403, 'owner_only']);
    should(reads).deepEqual([]);
  });

  it('should never be cached: a stored page shows a question that has been answered', async () => {
    // Arrange
    const { get } = fixture();

    // Act
    const response = await get();

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });
});
