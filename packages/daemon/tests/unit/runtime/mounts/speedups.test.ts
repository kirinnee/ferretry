import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { speedupRoutes } from '../../../../src/lib/runtime/mounts/speedups.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, FakeSpeedups, GRANTED, human } from './support.ts';

/**
 * The Speed-ups surface: a names-only status read and a Test. Neither takes nor returns a key.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function dispatcher(subsystem: FakeSpeedups): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(speedupRoutes(subsystem)), CREDENTIALS, GRANTED);
}

describe('the speed-ups mount', () => {
  it('should serve a status read and a per-provider Test, both operator-only, uncacheable and governed as secrets.use', () => {
    // Arrange / Act
    const routes = speedupRoutes(new FakeSpeedups());

    // Assert
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
      'GET /v1/speedups',
      'POST /v1/speedups/:provider/test',
    ]);
    should(routes.every(route => route.minimum === 'operator' && route.noStore === true)).be.true();
    should(routes.map(route => route.capability)).deepEqual([
      { capability: 'secrets', axis: 'use' },
      { capability: 'secrets', axis: 'use' },
    ]);
  });

  it('should answer the status read with the service view', async () => {
    // Act
    const response = await dispatcher(new FakeSpeedups()).dispatch(request({ path: '/v1/speedups', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ providers: [], vault: 'ok' });
  });

  it('should test the named provider and answer its result', async () => {
    // Arrange
    const subsystem = new FakeSpeedups();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ method: 'POST', path: '/v1/speedups/cerebras/test', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).code).equal('ok');
    should(subsystem.tested).deepEqual(['cerebras']);
  });

  it('should refuse a provider it does not know without testing anything', async () => {
    // Arrange
    const subsystem = new FakeSpeedups();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ method: 'POST', path: '/v1/speedups/openai/test', headers: human }),
    );

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response).code).equal('unknown_provider');
    should(subsystem.tested).be.empty();
  });

  it('should refuse the warden: a Test bills the operator', async () => {
    // Arrange
    const subsystem = new FakeSpeedups();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ method: 'POST', path: '/v1/speedups/groq/test', headers: warden }),
    );

    // Assert
    should(response.status).equal(403);
    should(subsystem.tested).be.empty();
  });
});
