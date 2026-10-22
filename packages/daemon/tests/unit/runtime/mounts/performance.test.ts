import { describe, it } from 'bun:test';
import {
  PERFORMANCE_PROFILE_PATH,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { type PerformanceSubsystem, performanceRoutes } from '../../../../src/lib/runtime/mounts/performance.ts';
import { request } from '../../api/support.ts';

const RUNNING: PerformanceProfileView = {
  state: 'running',
  id: 'p1',
  startedAt: '2024-05-01T10:00:00.000Z',
  endsAt: '2024-05-01T10:00:30.000Z',
};

/** A subsystem that records what it was asked and answers from a table. */
function subsystem(known: readonly PerformanceProfileView[] = [RUNNING]) {
  const started: number[] = [];
  const subject: PerformanceSubsystem = {
    start: seconds => {
      started.push(seconds);
      return RUNNING;
    },
    view: id => known.find(view => view.id === id),
  };
  return { subject, started };
}

function route(world: PerformanceSubsystem, method: 'POST' | 'GET') {
  const found = performanceRoutes(world).find(candidate => candidate.method === method);
  if (found === undefined) throw new Error(`no ${method} route`);
  return found;
}

function context(path: string, body?: string, id?: string): RouteContext {
  return {
    request: request({ method: id === undefined ? 'POST' : 'GET', path, ...(body === undefined ? {} : { body }) }),
    params: new Map(id === undefined ? [] : [['id', id]]),
  };
}

describe('the performance mount', () => {
  it('should declare both routes operator-only and uncached', () => {
    // Arrange
    const { subject } = subsystem();

    // Act
    const actual = performanceRoutes(subject).map(({ method, path, minimum, noStore }) => ({
      method,
      path,
      minimum,
      noStore,
    }));

    // Assert
    should(actual).deepEqual([
      { method: 'POST', path: PERFORMANCE_PROFILE_PATH, minimum: 'operator', noStore: true },
      { method: 'GET', path: `${PERFORMANCE_PROFILE_PATH}/:id`, minimum: 'operator', noStore: true },
    ]);
  });

  it('should start a profile and answer 202 with the running view', async () => {
    // Arrange
    const { subject, started } = subsystem();
    const input = context(PERFORMANCE_PROFILE_PATH, JSON.stringify({ seconds: 30 }));

    // Act
    const actual = await route(subject, 'POST').handle(input);

    // Assert
    should(actual.status).equal(202);
    should(PerformanceProfileViewSchema.parse(JSON.parse(actual.body))).deepEqual(RUNNING);
    should(started).deepEqual([30]);
  });

  it.each([
    ['not json', 'nope'],
    ['seconds below the minimum', JSON.stringify({ seconds: 1 })],
    ['seconds above the maximum', JSON.stringify({ seconds: 9999 })],
    ['no seconds', JSON.stringify({})],
  ])('should refuse a bad body with a 400 (%s)', async (_name, body) => {
    // Arrange
    const { subject, started } = subsystem();
    const input = context(PERFORMANCE_PROFILE_PATH, body);

    // Act
    const actual = await route(subject, 'POST')
      .handle(input)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(actual).be.instanceOf(ApiError);
    should((actual as ApiError).status).equal(400);
    should(started).deepEqual([]);
  });

  it('should answer a known profile by its id', async () => {
    // Arrange
    const { subject } = subsystem();
    const input = context(`${PERFORMANCE_PROFILE_PATH}/p1`, undefined, 'p1');

    // Act
    const actual = await route(subject, 'GET').handle(input);

    // Assert
    should(actual.status).equal(200);
    should(PerformanceProfileViewSchema.parse(JSON.parse(actual.body))).deepEqual(RUNNING);
  });

  it.each([
    ['an unknown id', 'missing'],
    ['an undecodable id', '%E0%A4%A'],
    ['an id with a path separator', 'a%2Fb'],
  ])('should answer 404 profile_not_found for %s', async (_name, id) => {
    // Arrange
    const { subject } = subsystem();
    const input = context(`${PERFORMANCE_PROFILE_PATH}/${id}`, undefined, id);

    // Act
    const actual = await route(subject, 'GET').handle(input);

    // Assert
    should(actual.status).equal(404);
    should(JSON.parse(actual.body).code).equal('profile_not_found');
  });

  it('should read the id through the decoder', async () => {
    // Arrange
    const encoded: PerformanceProfileView = { ...RUNNING, id: 'a b' };
    const { subject } = subsystem([encoded]);
    const input = context(`${PERFORMANCE_PROFILE_PATH}/a%20b`, undefined, 'a%20b');

    // Act
    const actual = await route(subject, 'GET').handle(input);

    // Assert
    should(actual.status).equal(200);
    should(JSON.parse(actual.body).id).equal('a b');
  });
});
