/**
 * Keeping existing conversations as ferrets, at the daemon's front door: the listing reads its query
 * from the URL and never caches, and an adoption is parsed before the service sees it.
 */
import { describe, it } from 'bun:test';
import type { ConversationAdoptRequest, ConversationImportListing, ConversationImportQuery } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type ConversationImportSubsystem,
  conversationImportRoutes,
} from '../../../../src/lib/runtime/mounts/conversation-import.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const LISTING: ConversationImportListing = {
  conversations: [
    {
      id: 'c1',
      harness: 'claude',
      project: '/work/shop',
      preview: 'Fix the cart',
      lastActivityAt: '2026-10-18T08:00:00.000Z',
      turns: 3,
    },
  ],
  matched: 1,
  skipped: 0,
};

function stub(): {
  subsystem: ConversationImportSubsystem;
  queries: ConversationImportQuery[];
  adoptions: ConversationAdoptRequest[];
} {
  const queries: ConversationImportQuery[] = [];
  const adoptions: ConversationAdoptRequest[] = [];
  return {
    queries,
    adoptions,
    subsystem: {
      list: async query => {
        queries.push(query ?? {});
        return LISTING;
      },
      preview: async (harness, id) =>
        id === 'c1' ? { id, harness, messages: [{ role: 'user', text: 'Fix the cart' }] } : undefined,
      adopt: async body => {
        adoptions.push(body);
        return { adopted: [{ id: 'c1', session: 's1', name: 'Mika', status: 'stopped' }], refused: [] };
      },
    },
  };
}

const dispatcher = (subsystem: ConversationImportSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(conversationImportRoutes(subsystem)), CREDENTIALS, GRANTED);

describe('the conversation import mount', () => {
  it('should read the search from the URL, drop empty values and never let the answer be cached', async () => {
    // Arrange
    const { subsystem, queries } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({
        path: '/v1/imports/conversations',
        headers: human,
        loopback: true,
        query: [
          ['source', 'ferretry'],
          ['harness', 'claude'],
          ['q', 'cart'],
          ['since', ''],
          ['limit', '20'],
        ],
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(LISTING);
    should(queries).deepEqual([{ source: 'ferretry', harness: 'claude', q: 'cart', limit: 20 }]);
  });

  it('should refuse a search it cannot read with a sentence', async () => {
    // Arrange
    const { subsystem, queries } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ path: '/v1/imports/conversations', headers: human, loopback: true, query: [['harness', 'gemini']] }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).containDeep({ code: 'invalid_query' });
    should(queries).deepEqual([]);
  });

  it('should hand an adoption its parsed request, with start defaulting off', async () => {
    // Arrange
    const { subsystem, adoptions } = stub();
    const body = { harness: 'claude', runtime: 'claude-default', conversations: [{ id: 'c1' }] };

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({
        method: 'POST',
        path: '/v1/imports/conversations/adopt',
        headers: { ...human, 'content-type': 'application/json' },
        loopback: true,
        body: JSON.stringify(body),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).containDeep({ adopted: [{ session: 's1' }] });
    should(adoptions).deepEqual([{ ...body, conversations: [{ id: 'c1', start: false }] }]);
  });
});

describe('the conversation preview', () => {
  it('should answer the last exchanges of one conversation, never cached', async () => {
    // Arrange
    const { subsystem } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ path: '/v1/imports/conversations/claude/c1/preview', headers: human, loopback: true }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual({
      id: 'c1',
      harness: 'claude',
      messages: [{ role: 'user', text: 'Fix the cart' }],
    });
  });

  it('should refuse an unknown CLI or a bad id, and say when no such conversation is here', async () => {
    // Arrange
    const { subsystem } = stub();
    const at = async (path: string) =>
      await dispatcher(subsystem).dispatch(request({ path, headers: human, loopback: true }));

    // Act
    const unknownCli = await at('/v1/imports/conversations/gemini/c1/preview');
    const badId = await at('/v1/imports/conversations/claude/-c1/preview');
    const missing = await at('/v1/imports/conversations/codex/c2/preview');

    // Assert
    should([unknownCli.status, badId.status, missing.status]).deepEqual([400, 400, 404]);
    should(jsonBody(unknownCli)).containDeep({ code: 'invalid_conversation' });
  });
});
