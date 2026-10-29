import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import type { ImportedConversationDetail } from '../../../../src/lib/imports/index.ts';
import { foreignHistoryRoutes } from '../../../../src/lib/runtime/mounts/foreign-history.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

const CONVERSATION = {
  id: 'abc',
  harness: 'claude',
  title: 'Read-only',
  source: '/home/operator/.claude/projects/p/a.jsonl',
  eventCount: 4,
  readOnly: true,
} as const;

function dispatcher(detail: ImportedConversationDetail | undefined): ApiDispatcher {
  const routes = foreignHistoryRoutes({
    list: async () => ({ conversations: [], skipped: [] }),
    get: async id => (id === CONVERSATION.id ? detail : undefined),
  });
  return new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

describe('the foreign history detail mount', () => {
  it('should name each message by the most specific id its record carries, falling back to its position', async () => {
    // Arrange
    const base = { kind: 'message', harness: 'claude', role: 'user' } as const;
    const surface = dispatcher({
      ...CONVERSATION,
      events: [
        { ...base, text: 'record', recordId: 'r1', itemId: 'i1', messageId: 'm1' },
        { ...base, text: 'item', itemId: 'i2', messageId: 'm2' },
        { ...base, text: 'message', messageId: 'm3' },
        { ...base, text: 'positioned', role: 'assistant', line: 7, blockIndex: 2 },
        { ...base, text: 'unplaced', role: 'assistant' },
        { ...base, text: 'tool output', role: 'tool', recordId: 'r6' },
      ],
    });

    // Act
    const response = await surface.dispatch(request({ path: '/v1/imports/history/abc', headers: human }));

    // Assert — the path of the source never leaves the daemon, and tool output is not a message.
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({
      conversation: {
        id: 'abc',
        harness: 'claude',
        title: 'Read-only',
        eventCount: 4,
        readOnly: true,
      },
      messages: [
        { id: 'r1', role: 'user', text: 'record' },
        { id: 'i2', role: 'user', text: 'item' },
        { id: 'm3', role: 'user', text: 'message' },
        { id: '7:2', role: 'assistant', text: 'positioned' },
        { id: '0:0', role: 'assistant', text: 'unplaced' },
      ],
    });
  });

  it('should answer 404 for an import that is not there', async () => {
    const response = await dispatcher(undefined).dispatch(
      request({ path: '/v1/imports/history/missing', headers: human }),
    );

    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it('should refuse a request that arrives with no usable import id', async () => {
    // Arrange — the router never matches an empty segment, so the handler is asked directly.
    const route = foreignHistoryRoutes({
      list: async () => ({ conversations: [], skipped: [] }),
      get: async () => undefined,
    })[1];
    if (route === undefined) throw new Error('the foreign history detail route must be mounted');

    // Act + Assert
    for (const params of [new Map<string, string>(), new Map([['importId', '']])])
      await Promise.resolve(route.handle({ request: request(), params })).should.be.rejectedWith({
        status: 400,
        code: 'invalid_import_id',
      });
  });
});
