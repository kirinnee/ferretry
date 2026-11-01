import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import type { ApiRoute, RouteContext } from '../../../src/lib/api/route.ts';
import { observedRoutes } from '../../../src/lib/performance/observed-routes.ts';
import { NO_PERFORMANCE_PROBE, type PerformanceProbe } from '../../../src/lib/performance/recorder.ts';

interface RouteCall {
  readonly route: string;
  readonly wallMs: number;
  readonly status: number;
  readonly bytes: number;
}

const context = {} as RouteContext;

function probeOf(recording: boolean, calls: RouteCall[]): PerformanceProbe {
  return {
    ...NO_PERFORMANCE_PROBE,
    recording,
    route: (route, wallMs, status, bytes) => void calls.push({ route, wallMs, status, bytes }),
  };
}

/** A clock that reads each value in turn. */
function clockOf(...readings: number[]) {
  let reads = 0;
  return {
    now: () => readings[reads++] ?? 0,
    get reads() {
      return reads;
    },
  };
}

function routeOf(handle: ApiRoute['handle'], method = 'get', path = '/v1/sessions/:id'): ApiRoute {
  return { method, path, minimum: 'operator', caller: 'any', handle };
}

const respond = (status: number, body: string): ApiResponse => ({ status, headers: new Map(), body });

describe('observedRoutes', () => {
  it('should answer through the route untouched, and record nothing, while no window is open', async () => {
    // Arrange
    const calls: RouteCall[] = [];
    const clock = clockOf(1, 2);
    const response = respond(200, 'ok');
    const [subject] = observedRoutes([routeOf(async () => response)], probeOf(false, calls), clock);

    // Act
    const actual = await subject?.handle(context);

    // Assert
    should(actual).equal(response);
    should(calls).deepEqual([]);
    should(clock.reads).equal(0);
  });

  it('should record the pattern, wall time, status and body bytes of an answered request', async () => {
    // Arrange
    const calls: RouteCall[] = [];
    const [subject] = observedRoutes(
      [routeOf(async () => respond(201, 'héllo'))],
      probeOf(true, calls),
      clockOf(100, 117.5),
    );

    // Act
    const actual = await subject?.handle(context);

    // Assert
    should(actual?.status).equal(201);
    should(calls).deepEqual([{ route: 'GET /v1/sessions/:id', wallMs: 17.5, status: 201, bytes: 6 }]);
  });

  it.each([
    ['post', '/v1/sessions', 'POST /v1/sessions'],
    ['GET', '/healthz', 'GET /healthz'],
    ['delete', '/v1/sessions/:id/fs/*rest', 'DELETE /v1/sessions/:id/fs/*rest'],
  ])('should name a %s route on %s as %s', async (method, path, expected) => {
    // Arrange
    const calls: RouteCall[] = [];
    const [subject] = observedRoutes(
      [routeOf(async () => respond(200, ''), method, path)],
      probeOf(true, calls),
      clockOf(0, 1),
    );

    // Act
    await subject?.handle(context);

    // Assert
    should(calls.map(call => call.route)).deepEqual([expected]);
  });

  it('should record a thrown ApiError under its own status and rethrow it', async () => {
    // Arrange
    const calls: RouteCall[] = [];
    const failure = new ApiError(404, 'not found');
    const [subject] = observedRoutes(
      [
        routeOf(async () => {
          throw failure;
        }),
      ],
      probeOf(true, calls),
      clockOf(10, 14),
    );

    // Act
    const actual = await subject?.handle(context).catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
    should(calls).deepEqual([{ route: 'GET /v1/sessions/:id', wallMs: 4, status: 404, bytes: 0 }]);
  });

  it('should record any other throw as a 500 and rethrow it', async () => {
    // Arrange
    const calls: RouteCall[] = [];
    const failure = new Error('boom');
    const [subject] = observedRoutes(
      [
        routeOf(async () => {
          throw failure;
        }),
      ],
      probeOf(true, calls),
      clockOf(0, 3),
    );

    // Act
    const actual = await subject?.handle(context).catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
    should(calls).deepEqual([{ route: 'GET /v1/sessions/:id', wallMs: 3, status: 500, bytes: 0 }]);
  });

  it('should keep every other field of each route and wrap each one', () => {
    // Arrange
    const first = { ...routeOf(async () => respond(200, '')), noStore: true } satisfies ApiRoute;
    const second = routeOf(async () => respond(200, ''), 'post', '/x');

    // Act
    const actual = observedRoutes([first, second], NO_PERFORMANCE_PROBE, clockOf());

    // Assert
    should(actual).have.length(2);
    should(actual[0]?.noStore).be.true();
    should(actual[0]?.minimum).equal('operator');
    should(actual[0]?.handle).not.equal(first.handle);
    should(actual[1]?.path).equal('/x');
  });
});
