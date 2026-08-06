import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { NameSuggestionsSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { CALLSIGN_WINDOW_MS, DEFAULT_CALLSIGN_POOL, type NameClaim } from '../../../../src/lib/names/index.ts';
import { nameRoutes } from '../../../../src/lib/runtime/mounts/names.ts';
import { jsonBody, request } from '../../api/support.ts';
import { AT_MS, CREDENTIALS, human, nameClaim, nameSubsystem } from './support.ts';

/**
 * The callsign suggestion route, driven through the real router over the real pool.
 *
 * The start index is pinned to zero in the fixture, so "the first free callsign" is the pool's own
 * first entry and a case can name it. Production randomises the start; that is asserted by reading
 * the port rather than by re-running this route.
 */

function dispatcher(claims: readonly NameClaim[] = [], nowMs: number = AT_MS): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(nameRoutes(nameSubsystem(claims, nowMs))),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
}

async function suggested(claims: readonly NameClaim[] = [], query: readonly (readonly [string, string])[] = []) {
  const response = await dispatcher(claims).dispatch(request({ path: '/v1/names', headers: human, query }));
  should(response.status).equal(200);
  return NameSuggestionsSchema.parse(jsonBody(response));
}

/** The first entries of the shipped pool, which is sorted, so the expectations below are stable. */
const FIRST = DEFAULT_CALLSIGN_POOL[0]!;
const SECOND = DEFAULT_CALLSIGN_POOL[1]!;

describe('the callsign suggestion mount', () => {
  it('should offer one free callsign when no count is asked for', async () => {
    // Arrange / Act
    const names = await suggested();

    // Assert
    should(names).deepEqual([FIRST]);
  });

  it('should offer as many distinct callsigns as the caller asked for', async () => {
    // Arrange / Act
    const names = await suggested([], [['count', '5']]);

    // Assert
    should(names).have.length(5);
    should(new Set(names).size).equal(5);
  });

  it('should skip a callsign the fleet is currently using', async () => {
    // This is the whole point of the route: a name it offers must not be one somebody answers to.
    // Arrange / Act
    const names = await suggested([nameClaim(FIRST)], [['count', '2']]);

    // Assert
    should(names).deepEqual([SECOND, DEFAULT_CALLSIGN_POOL[2]!]);
  });

  it('should offer a callsign again once its claim has aged out of the window', async () => {
    // A session that ended long ago must not hold its name forever, or the pool only ever shrinks.
    // Arrange
    const expired = nameClaim(FIRST, 's1', AT_MS - CALLSIGN_WINDOW_MS - 1);

    // Act
    const response = await dispatcher([expired]).dispatch(request({ path: '/v1/names', headers: human }));

    // Assert
    should(NameSuggestionsSchema.parse(jsonBody(response))).deepEqual([FIRST]);
  });

  it('should refuse a count that is not a whole positive number', async () => {
    // Clamping a nonsense count to one would look like a pool with a single name left in it.
    // Arrange / Act
    const zero = await dispatcher().dispatch(request({ path: '/v1/names', headers: human, query: [['count', '0']] }));
    const words = await dispatcher().dispatch(
      request({ path: '/v1/names', headers: human, query: [['count', 'ten']] }),
    );

    // Assert
    should([zero.status, words.status]).deepEqual([400, 400]);
    should(jsonBody(zero)).have.property('code', 'invalid_count');
  });

  it('should refuse a parameter it does not implement rather than ignore it', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(
      request({ path: '/v1/names', headers: human, query: [['prefix', 'a']] }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'unknown_parameter');
  });

  it('should refuse a caller without the admin token', async () => {
    // The answer says which callsigns are taken, which is a roster of who is alive.
    // Arrange / Act
    const response = await dispatcher().dispatch(
      request({
        path: '/v1/names',
        headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' },
      }),
    );

    // Assert
    should(response.status).equal(403);
  });
});
