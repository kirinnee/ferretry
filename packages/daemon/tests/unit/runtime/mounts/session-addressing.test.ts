import { describe, it } from 'bun:test';
import type { AgentAddressCandidate } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import type { ApiRoute, RouteContext } from '../../../../src/lib/api/route.ts';
import type { SocketRoute } from '../../../../src/lib/api/socket.ts';
import { jsonResponse } from '../../../../src/lib/api/responses.ts';
import {
  addressedParameters,
  type SessionAddressBook,
  sessionAddressedRoutes,
  sessionAddressedSockets,
} from '../../../../src/lib/runtime/mounts/session-addressing.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const ANIYA = 'mvb0sw7d-27f71326';
const TORREY = 'mvb0aaaa-11111111';

/** A fleet of two named agents, counting how often the documents were read. */
function addressBook(extra: readonly AgentAddressCandidate[] = []) {
  const fleet: AgentAddressCandidate[] = [
    { id: ANIYA, name: 'aniya', status: 'running' },
    { id: TORREY, name: 'torrey', status: 'waiting' },
    ...extra,
  ];
  let reads = 0;
  const book: SessionAddressBook = {
    has: id => fleet.some(candidate => candidate.id === id),
    candidates: async () => {
      reads += 1;
      return fleet;
    },
  };
  return { book, reads: () => reads };
}

/** A route that answers with the session id it was handed. */
const echo = (path: string): ApiRoute => ({
  method: 'POST',
  path,
  minimum: 'operator',
  handle: async (context: RouteContext) => jsonResponse({ sessionId: context.params.get('sessionId') ?? null }),
});

describe('addressing a session by its agent name', () => {
  it('should hand every per-session route the session a name addresses, in any case', async () => {
    // Arrange
    const { book } = addressBook();
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionAddressedRoutes(book, [echo('/v1/sessions/:sessionId/send')])),
      CREDENTIALS,
      GRANTED,
    );

    // Act
    const answers = await Promise.all(
      ['aniya', 'Aniya', '%3Aaniya', ANIYA].map(reference =>
        dispatcher.dispatch(request({ method: 'POST', path: `/v1/sessions/${reference}/send`, headers: human })),
      ),
    );

    // Assert — the composer's `:aniya` spelling is an address too.
    for (const answer of answers) should(JSON.parse(answer.body)).deepEqual({ sessionId: ANIYA });
  });

  it('should never read the fleet for an exact id', async () => {
    // Arrange
    const { book, reads } = addressBook();
    const params = new Map([['sessionId', TORREY]]);

    // Act
    const resolved = await addressedParameters(book, params);

    // Assert — the same map, untouched, and no document read on the hot path every poll takes.
    should(resolved).equal(params);
    should(reads()).equal(0);
  });

  it('should leave a name nobody holds, an unusable parameter and a route without one as they came', async () => {
    // Arrange
    const { book } = addressBook();
    const unknown = new Map([['sessionId', 'zelda']]);
    const undecodable = new Map([['sessionId', '%E0%A4%A']]);
    const none = new Map([['terminalId', 'aniya']]);

    // Act / Assert — the route then answers exactly what it answers for an unknown id today.
    should(await addressedParameters(book, unknown)).equal(unknown);
    should(await addressedParameters(book, undecodable)).equal(undecodable);
    should(await addressedParameters(book, none)).equal(none);
  });

  it('should refuse a name two live sessions hold, listing both', async () => {
    // Arrange
    const { book } = addressBook([{ id: 'lzz00000-00000000', name: 'aniya', status: 'running' }]);
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionAddressedRoutes(book, [echo('/v1/sessions/:sessionId/send')])),
      CREDENTIALS,
      GRANTED,
    );

    // Act
    const answer = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/aniya/send', headers: human }),
    );

    // Assert
    should(answer.status).equal(409);
    should(answer.body).containEql('ambiguous_agent_name');
    should(answer.body).containEql(ANIYA);
    should(answer.body).containEql('lzz00000-00000000');
  });

  it('should leave routes that take no session untouched', () => {
    // Arrange
    const { book } = addressBook();
    const plain = echo('/v1/fleet-sessions');

    // Act / Assert
    should(sessionAddressedRoutes(book, [plain])[0]).equal(plain);
  });

  it('should address a socket by name the same way', async () => {
    // Arrange
    const { book } = addressBook();
    const seen: (string | undefined)[] = [];
    const socket: SocketRoute = {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals/:terminalId/stream',
      minimum: 'operator',
      accept: async context => {
        seen.push(context.params.get('sessionId'));
        return async () => ({ onMessage: () => undefined, onClose: () => undefined }) as never;
      },
    };
    const plain: SocketRoute = { ...socket, path: '/v1/events' };
    const [addressed, untouched] = sessionAddressedSockets(book, [socket, plain]);
    const context = (sessionId: string): RouteContext => ({
      request: request({ path: '/' }),
      params: new Map([
        ['sessionId', sessionId],
        ['terminalId', 't'],
      ]),
    });

    // Act
    await addressed?.accept(context('torrey'));
    await addressed?.accept(context(TORREY));

    // Assert
    should(seen).deepEqual([TORREY, TORREY]);
    should(untouched).equal(plain);
  });
});
