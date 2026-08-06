import { describe, it } from 'bun:test';
import {
  FY_REQUEST_ID_HEADER,
  type RuntimeControlRequest,
  RuntimeModelCatalogSchema,
  type RuntimeModelCatalog,
  type SessionView,
  SessionViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { sessionRuntimeRoutes } from '../../../../src/lib/runtime/mounts/session-runtime.ts';
import {
  SessionRuntimeError,
  type SessionRuntimeSubsystem,
} from '../../../../src/lib/session/runtime-control/types.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionView } from './support.ts';

/**
 * The two addresses the browser's composer has always dialled and the daemon never answered.
 *
 * Everything goes through the real dispatcher and the real credentials, because one of the facts this
 * mount hands the domain does not come from the body at all: the idempotency key travels in a header,
 * and a retried control that lost it drives a live modal twice.
 */

const CATALOG: RuntimeModelCatalog = {
  harness: 'codex',
  source: 'codex-app-server',
  choices: [{ value: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', reasoningEfforts: [{ value: 'high' }] }],
};

class FakeSessionRuntime implements SessionRuntimeSubsystem {
  readonly reads: string[] = [];
  readonly controls: [string, RuntimeControlRequest, string][] = [];

  constructor(private readonly failure?: SessionRuntimeError) {}

  async models(sessionId: string): Promise<RuntimeModelCatalog> {
    this.reads.push(sessionId);
    if (this.failure !== undefined) throw this.failure;
    return CATALOG;
  }

  async control(sessionId: string, control: RuntimeControlRequest, requestId: string): Promise<SessionView> {
    this.controls.push([sessionId, control, requestId]);
    if (this.failure !== undefined) throw this.failure;
    return sessionView(sessionId, { harness: 'codex' }, { status: 'running', observedModel: 'gpt-5.6-codex' });
  }
}

function dispatcher(subsystem: SessionRuntimeSubsystem = new FakeSessionRuntime()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionRuntimeRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const withRequestId = (headers: Readonly<Record<string, string>> = human, id = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: id,
});

const catalogRequest = (sessionId: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'GET', path: `/v1/sessions/${sessionId}/runtime-models`, headers });

const controlRequest = (
  sessionId: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = withRequestId(),
) => request({ method: 'POST', path: `/v1/sessions/${sessionId}/runtime`, headers, body: JSON.stringify(body) });

describe('the runtime model catalog route', () => {
  it('should answer with a catalog the client will accept', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(catalogRequest('s1'));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the browser would refuse is a catalog that failed.
    should(RuntimeModelCatalogSchema.parse(JSON.parse(response.body)).choices).have.length(1);
    should(runtime.reads).deepEqual(['s1']);
  });

  it('should never let the answer be cached', async () => {
    // The catalog is read LIVE from the account; a cached copy names models it no longer serves.
    // Arrange
    const subject = dispatcher();

    // Act
    const response = await subject.dispatch(catalogRequest('s1'));

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });

  it('should decode a session id the transport escaped', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    await subject.dispatch(catalogRequest(encodeURIComponent('session one')));

    // Assert
    should(runtime.reads).deepEqual(['session one']);
  });

  it('should refuse a path parameter that regains a separator', async () => {
    // A decoded parameter that becomes a path would address something the router never matched.
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(catalogRequest('%2fetc%2fpasswd'));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('invalid_session_id');
    should(runtime.reads).deepEqual([]);
  });

  it('should say the session is not here rather than answer an empty catalog', async () => {
    // Arrange
    const subject = dispatcher(new FakeSessionRuntime(new SessionRuntimeError('not_found', 'no session s9')));

    // Act
    const response = await subject.dispatch(catalogRequest('s9'));

    // Assert
    should(response.status).equal(404);
    should(JSON.parse(response.body).code).equal('not-found');
  });

  it('should report a catalog it could not read as a failure, never as no choices', async () => {
    // An empty list would send the reader to the native-picker fallback while implying the account
    // genuinely offers nothing — which is a different, and wrong, thing to tell them.
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(new SessionRuntimeError('catalog_unavailable', 'the probe timed out after 10s')),
    );

    // Act
    const response = await subject.dispatch(catalogRequest('s1'));

    // Assert
    should(response.status).equal(503);
    should(JSON.parse(response.body)).match({
      code: 'runtime_catalog_unavailable',
      error: 'the probe timed out after 10s',
    });
  });
});

describe('the runtime control route', () => {
  it('should apply a control and answer with the session it changed', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(
      controlRequest('s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'high' }),
    );

    // Assert
    should(response.status).equal(200);
    should(SessionViewSchema.parse(JSON.parse(response.body)).state.observedModel).equal('gpt-5.6-codex');
    should(runtime.controls).deepEqual([['s1', { action: 'model', model: 'gpt-5.6-codex', effort: 'high' }, 'req-1']]);
  });

  it('should carry each arm of the request union through untouched', async () => {
    // The two chips are independent BECAUSE the union says so; folding one arm into another here
    // would quietly make a level change also a model change.
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    await subject.dispatch(controlRequest('s1', { action: 'effort', effort: 'xhigh' }));
    await subject.dispatch(controlRequest('s1', { action: 'model' }, withRequestId(human, 'req-2')));
    await subject.dispatch(controlRequest('s1', { action: 'compact' }, withRequestId(human, 'req-3')));

    // Assert
    should(runtime.controls.map(([, control]) => control)).deepEqual([
      { action: 'effort', effort: 'xhigh' },
      { action: 'model' },
      { action: 'compact' },
    ]);
  });

  it('should take the idempotency key from the header the client already sends', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    await subject.dispatch(controlRequest('s1', { action: 'compact' }, withRequestId(human, 'switch-42')));

    // Assert
    should(runtime.controls[0]?.[2]).equal('switch-42');
  });

  it('should refuse a control that carries no request id', async () => {
    // A key the daemon invented for itself would be idempotent against nothing, and a retry whose
    // answer was lost would drive the picker a second time.
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }, human));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('missing_request_id');
    should(runtime.controls).deepEqual([]);
  });

  it('should refuse a request id that is only whitespace', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }, withRequestId(human, '   ')));

    // Assert
    should(response.status).equal(400);
    should(runtime.controls).deepEqual([]);
  });

  it('should refuse a body the request union does not describe', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const unknownArm = await subject.dispatch(controlRequest('s1', { action: 'reboot' }));
    const strayField = await subject.dispatch(
      controlRequest('s1', { action: 'compact', model: 'gpt-5.6-codex' }, withRequestId(human, 'req-2')),
    );

    // Assert
    should(unknownArm.status).equal(400);
    should(strayField.status).equal(400);
    should(runtime.controls).deepEqual([]);
  });

  it('should refuse a busy or terminal session with a conflict, not a failure', async () => {
    // The browser promises a refusal rather than a queue; the status is what tells it to say "wait"
    // instead of "something broke".
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(
        new SessionRuntimeError(
          'refused',
          'a runtime control is available only while the harness is waiting at an idle prompt',
        ),
      ),
    );

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.status).equal(409);
    should(JSON.parse(response.body)).match({
      code: 'runtime_control_refused',
      error: /only while the harness is waiting at an idle prompt/u,
    });
  });

  it('should separate what the harness cannot express from what it refused', async () => {
    // `422` is what tells the browser to offer its native-picker escape hatch rather than to fix the
    // body it just sent.
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(
        new SessionRuntimeError('unsupported', 'high is not advertised for Codex model gpt-5.6-codex'),
      ),
    );

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'model', model: 'x', effort: 'high' }));

    // Assert
    should(response.status).equal(422);
    should(JSON.parse(response.body).code).equal('runtime_control_unsupported');
  });

  it('should answer a spent request id carrying a different control with a conflict', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(
        new SessionRuntimeError('conflict', 'request id "req-1" was already spent on a different runtime control'),
      ),
    );

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.status).equal(409);
    should(JSON.parse(response.body).code).equal('request_id_reused');
  });

  it('should tell a caller its id already reached the harness rather than repeat it', async () => {
    // Its own code, not `request_id_reused`: the client did nothing wrong and there is nothing in the
    // request to correct, so "you reused an id" would send it looking for a bug it does not have.
    // Repeating the call is the one thing that must not happen — a second `/compact` discards context
    // nobody asked to lose.
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(
        new SessionRuntimeError(
          'unsettled',
          'request id "req-1" was already performed on this session and its outcome was not recorded',
        ),
      ),
    );

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.status).equal(409);
    should(JSON.parse(response.body)).match({
      code: 'runtime_control_unsettled',
      error: /already performed on this session/u,
    });
  });

  it('should report a drive that was attempted and failed as a failure', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(new SessionRuntimeError('failed', 'Codex picker drive failed: it exited')),
    );

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.status).equal(500);
    should(JSON.parse(response.body).code).equal('runtime_control_failed');
  });

  it('should say the session is not here rather than pretend a control landed', async () => {
    // Arrange
    const subject = dispatcher(new FakeSessionRuntime(new SessionRuntimeError('not_found', 'no session s9')));

    // Act
    const response = await subject.dispatch(controlRequest('s9', { action: 'compact' }));

    // Assert
    should(response.status).equal(404);
  });

  it('should refuse an unusable session id in the path', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);

    // Act
    const response = await subject.dispatch(controlRequest('%2f', { action: 'compact' }));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('invalid_session_id');
    should(runtime.controls).deepEqual([]);
  });

  it('should restate an unusable reference the domain refused', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionRuntime(new SessionRuntimeError('invalid', '"nope" is not a usable session id')),
    );

    // Act
    const response = await subject.dispatch(controlRequest('nope', { action: 'compact' }));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('invalid_request');
  });

  it('should let a failure that is not a stated refusal travel unchanged', async () => {
    // A bug in the composition root must not be dressed up as a 4xx the caller can act on.
    // Arrange
    const broken: SessionRuntimeSubsystem = {
      models: async () => {
        throw new Error('the world was built wrong');
      },
      control: async () => {
        throw new Error('the world was built wrong');
      },
    };
    const subject = dispatcher(broken);

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.status).equal(500);
    should(JSON.parse(response.body).code).not.equal('runtime_control_failed');
  });

  it('should never let a control answer be cached', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const response = await subject.dispatch(controlRequest('s1', { action: 'compact' }));

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });
});

describe('who may reach the runtime surface', () => {
  it('should refuse an unauthenticated caller on both routes', async () => {
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);
    const anonymous = { 'x-ferretry-client': 'cli' };

    // Act
    const read = await subject.dispatch(catalogRequest('s1', anonymous));
    const write = await subject.dispatch(controlRequest('s1', { action: 'compact' }, withRequestId(anonymous)));

    // Assert
    should(read.status).equal(401);
    should(write.status).equal(401);
    should(runtime.reads).deepEqual([]);
    should(runtime.controls).deepEqual([]);
  });

  it('should let no warden-scoped caller read or change a session runtime', async () => {
    // A warden judges a session; it does not get to change which model that session is paying for.
    // Arrange
    const runtime = new FakeSessionRuntime();
    const subject = dispatcher(runtime);
    const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' };

    // Act
    const read = await subject.dispatch(catalogRequest('s1', warden));
    const write = await subject.dispatch(controlRequest('s1', { action: 'compact' }, withRequestId(warden)));

    // Assert
    should(read.status).equal(403);
    should(write.status).equal(403);
    should(runtime.reads).deepEqual([]);
    should(runtime.controls).deepEqual([]);
  });
});
