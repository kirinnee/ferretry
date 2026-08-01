import { describe, it } from 'bun:test';
import should from 'should';
import { ApiRawDispatcher } from '../../../../src/lib/api/raw.ts';
import { VERSION_HEADER } from '../../../../src/lib/api/responses.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { sttRawRoutes } from '../../../../src/lib/runtime/mounts/stt.ts';
import { daemonVersion } from '../../../../src/lib/version.ts';
import { request } from '../../api/support.ts';
import { FakeStt } from './support.ts';

/**
 * Dictation, over the routes `fy stt` has always spoken.
 *
 * The subsystem was constructed by the composition root and called by nothing, so every one of
 * these paths answered `unknown_route`. These cases are about the mount: that each path reaches the
 * surface, that the surface's own bytes come back untouched, and that the two things the mount adds
 * — the version stamp and the answer for a path only ONE of the two matchers claims — are right.
 */

const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret' } as const;

const human = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}` } as const;

function dispatcherFor(stt: FakeStt): ApiRawDispatcher {
  return new ApiRawDispatcher(new ApiRouter(sttRawRoutes(stt)), CREDENTIALS);
}

function transport(path: string, method = 'GET', init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:9999${path}`, { method, ...init });
}

describe('the dictation mount', () => {
  it('should serve every route the CLI gateway speaks', async () => {
    // Arrange
    const stt = new FakeStt();

    // Act
    const routes = sttRawRoutes(stt).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual([
      'GET /v1/stt/status',
      'GET /v1/stt/models',
      'GET /v1/stt/models/:modelId/install',
      'POST /v1/stt/models/:modelId/install',
      'GET /v1/stt/models/:modelId',
      'POST /v1/stt/transcribe',
      'POST /v1/stt/enhance',
    ]);
  });

  it('should reach the surface with the transport request untouched', async () => {
    // Arrange
    const stt = new FakeStt(request_ => Response.json({ seen: new URL(request_.url).pathname }));
    const dispatcher = dispatcherFor(stt);

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/stt/transcribe', headers: human }),
      transport('/v1/stt/transcribe', 'POST', {
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'audio/L16; rate=16000; channels=1' },
      }),
    );

    // Assert
    should(decision.kind).equal('served');
    if (decision.kind !== 'served') return;
    should(await decision.response.json()).deepEqual({ seen: '/v1/stt/transcribe' });
    should(stt.seen).deepEqual(['POST /v1/stt/transcribe']);
  });

  it('should stamp the daemon version on a response the surface built itself', async () => {
    // Arrange
    const dispatcher = dispatcherFor(new FakeStt(() => Response.json({ available: false })));

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'GET', path: '/v1/stt/status', headers: human }),
      transport('/v1/stt/status'),
    );

    // Assert
    should(decision.kind).equal('served');
    if (decision.kind !== 'served') return;
    should(decision.response.headers.get(VERSION_HEADER)).equal(daemonVersion);
  });

  it('should route the install verbs to the surface separately from the model read', async () => {
    // Arrange
    const stt = new FakeStt();
    const dispatcher = dispatcherFor(stt);

    // Act
    await dispatcher.serve(
      request({ method: 'POST', path: '/v1/stt/models/base.en/install', headers: human }),
      transport('/v1/stt/models/base.en/install', 'POST'),
    );
    await dispatcher.serve(
      request({ method: 'GET', path: '/v1/stt/models/base.en', headers: human }),
      transport('/v1/stt/models/base.en'),
    );

    // Assert
    should(stt.seen).deepEqual(['POST /v1/stt/models/base.en/install', 'GET /v1/stt/models/base.en']);
  });

  it('should answer 404 for a model id the surface decodes to no route at all', async () => {
    // Arrange — an encoded separator matches the router's raw `:modelId` segment and is then
    // refused by the surface's own decode, which is the one way the two matchers can disagree.
    const dispatcher = dispatcherFor(new FakeStt(() => undefined));

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'GET', path: '/v1/stt/models/a%2Fb', headers: human }),
      transport('/v1/stt/models/a%2Fb'),
    );

    // Assert
    should(decision.kind).equal('served');
    if (decision.kind !== 'served') return;
    should(decision.response.status).equal(404);
    should(await decision.response.json()).deepEqual({ error: 'model not found', code: 'model_not_found' });
  });

  it('should refuse the warden token: dictation spends the operator’s key and hardware', async () => {
    // Arrange
    const stt = new FakeStt();
    const dispatcher = dispatcherFor(stt);

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/stt/enhance', headers: warden }),
      transport('/v1/stt/enhance', 'POST'),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(403);
    should(stt.seen).deepEqual([]);
  });

  it('should refuse an unauthenticated caller before the worker can be reached', async () => {
    // Arrange
    const stt = new FakeStt();
    const dispatcher = dispatcherFor(stt);

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/stt/transcribe' }),
      transport('/v1/stt/transcribe', 'POST'),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(401);
    should(stt.seen).deepEqual([]);
  });

  it('should not claim the public model-file prefix, which is deliberately unmounted', async () => {
    // Arrange
    const dispatcher = dispatcherFor(new FakeStt());

    // Act / Assert — it falls through to the HTTP table, which answers `unknown_route`.
    should(dispatcher.claims(request({ method: 'GET', path: '/stt-models/base.en/model.bin' }))).equal(false);
  });
});
