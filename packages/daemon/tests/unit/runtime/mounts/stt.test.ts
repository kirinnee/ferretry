import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { VERSION_HEADER } from '../../../../src/lib/api/responses.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { sttEnhancementRoutes } from '../../../../src/lib/runtime/mounts/stt.ts';
import { SttEnhancementError } from '../../../../src/lib/stt/errors.ts';
import { daemonVersion } from '../../../../src/lib/version.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, FakeSttEnhancer, human } from './support.ts';

/**
 * Dictation enhancement — the daemon's one remaining speech-to-text route.
 *
 * These cases are about the mount rather than the enhancer: that the body reaches the service
 * UNPARSED so the service's own refusal vocabulary survives, that each refusal is projected with the
 * status and `{error, code}` body the domain decided, and that the operator's provider credential is
 * behind the admin boundary. The three enhancement cases the deleted byte-shaped service test carried
 * live here now, because this is where that behaviour moved.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function dispatcher(enhancer: FakeSttEnhancer): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sttEnhancementRoutes(enhancer)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

function post(body: string, headers: Readonly<Record<string, string>> = human) {
  return request({
    method: 'POST',
    path: '/v1/stt/enhance',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

describe('the dictation enhancement mount', () => {
  it('should serve one route, over the path the shipped clients already speak', () => {
    // Arrange / Act
    const routes = sttEnhancementRoutes(new FakeSttEnhancer()).map(route => `${route.method} ${route.path}`);

    // Assert — the CLI gateway and the PWA both post exactly this path.
    should(routes).deepEqual(['POST /v1/stt/enhance']);
  });

  it('should pass the body to the enhancer unparsed and return its result', async () => {
    // Arrange
    const enhancer = new FakeSttEnhancer();

    // Act
    const response = await dispatcher(enhancer).dispatch(post(JSON.stringify({ text: 'helo wold', provider: 'groq' })));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({
      text: 'Hello, world.',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      latencyMs: 42,
    });
    // UNPARSED: the service applies the wire schema itself, which is what lets it answer `too_long`
    // and `provider_unknown` rather than the mount's generic invalid-body refusal.
    should(enhancer.seen).deepEqual([{ text: 'helo wold', provider: 'groq' }]);
    should(response.headers.get(VERSION_HEADER)).equal(daemonVersion);
  });

  it('should answer an enhancement failure with the status and code the domain decided', async () => {
    // Arrange
    const enhancer = new FakeSttEnhancer(new SttEnhancementError('rate_limited', 'slow down'));

    // Act
    const response = await dispatcher(enhancer).dispatch(post(JSON.stringify({ text: 'x', provider: 'groq' })));

    // Assert
    should(response.status).equal(429);
    should(jsonBody(response)).deepEqual({ error: 'slow down', code: 'rate_limited' });
  });

  it('should refuse a body that is not JSON', async () => {
    // Arrange
    const enhancer = new FakeSttEnhancer();

    // Act
    const response = await dispatcher(enhancer).dispatch(post('not json'));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).deepEqual({ error: 'request body is not valid JSON', code: 'bad_request' });
    should(enhancer.seen).deepEqual([]);
  });

  it('should refuse a body it could not read at all', async () => {
    // Arrange — a client that vanished mid-upload. It is the caller's failure, not the daemon's, so
    // it answers 400 in the enhancer's own vocabulary rather than reaching the dispatcher's 500.
    const enhancer = new FakeSttEnhancer();

    // Act
    const response = await dispatcher(enhancer).dispatch(
      request({ method: 'POST', path: '/v1/stt/enhance', headers: human, unreadableBody: true }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).deepEqual({ error: 'request body could not be read', code: 'bad_request' });
    should(enhancer.seen).deepEqual([]);
  });

  it('should let a defect reach the dispatcher rather than dressing it as a refusal', async () => {
    // Arrange — anything that is not an `SttEnhancementError` is the daemon's fault, and its message
    // never comes back out: an enhancement failure can carry the provider's own text.
    const enhancer = {
      async enhance(): Promise<never> {
        throw new Error('the transport exploded at /home/operator/.fy/secrets');
      },
    };

    // Act
    const response = await new ApiDispatcher(
      new ApiRouter(sttEnhancementRoutes(enhancer)),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    ).dispatch(post(JSON.stringify({ text: 'x', provider: 'groq' })));

    // Assert
    should(response.status).equal(500);
    should(response.body).not.match(/secrets/u);
  });

  it('should refuse the warden token: enhancement spends the operator’s provider account', async () => {
    // Arrange
    const enhancer = new FakeSttEnhancer();

    // Act
    const response = await dispatcher(enhancer).dispatch(post(JSON.stringify({ text: 'x', provider: 'groq' }), warden));

    // Assert
    should(response.status).equal(403);
    should(enhancer.seen).deepEqual([]);
  });

  it('should refuse an unauthenticated caller before the credential can be spent', async () => {
    // Arrange
    const enhancer = new FakeSttEnhancer();

    // Act
    const response = await dispatcher(enhancer).dispatch(
      request({
        method: 'POST',
        path: '/v1/stt/enhance',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x', provider: 'groq' }),
      }),
    );

    // Assert
    should(response.status).equal(401);
    should(enhancer.seen).deepEqual([]);
  });
});
