import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { sessionControlRoutes } from '../../../../src/lib/runtime/mounts/session-control.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, fakePayloadDigest, FakeSessionControl, human } from './support.ts';

/**
 * The session write surface: what a start refuses, what it passes through, and what a stop answers.
 *
 * Every case goes through the real dispatcher and the real credentials, because the scope is half the
 * decision this mount makes: a start spawns a process holding the daemon's own privileges.
 */

const REQUEST_ID = 'req-7f3c';

function dispatcher(subsystem = new FakeSessionControl()): { readonly dispatch: ApiDispatcher['dispatch'] } {
  const instance = new ApiDispatcher(new ApiRouter(sessionControlRoutes(subsystem)), CREDENTIALS);
  return { dispatch: async apiRequest => await instance.dispatch(apiRequest) };
}

/** A start body with only what a case cares about spelled out. */
function startBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ agent: 'claude-auto-loge', mode: 'auto', prompt: 'wire the subsystems', ...overrides });
}

function startRequest(
  body: string,
  headers: Readonly<Record<string, string>> = { [FY_REQUEST_ID_HEADER]: REQUEST_ID },
) {
  return request({ method: 'POST', path: '/v1/sessions', headers: { ...human, ...headers }, body });
}

/** The recovery read as the protocol client issues it: the request id in the path, the digest of the
 *  body it posted in the query. */
function recoveryRequest(requestId: string, digest: string) {
  return request({
    method: 'GET',
    path: `/v1/sessions/by-request/${requestId}`,
    query: [['payload', digest]],
    headers: human,
  });
}

describe('the session control mount', () => {
  it('should start a session and answer with the view the read surface serves', async () => {
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(startRequest(startBody()));

    // Assert
    should(response.status).equal(201);
    // Parsed with the protocol's own schema: a body the client would refuse is a start that failed.
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.config.agent).equal('claude-auto-loge');
    should(view.state.status).equal('running');
    // The logical request id reached the subsystem rather than being dropped at the boundary.
    should(control.starts).deepEqual([[REQUEST_ID, 'claude-auto-loge']]);
  });

  it('should answer a retried start with the session the first attempt created', async () => {
    // The protocol client retries this POST on a transport error. Without the request id the second
    // attempt opens a second pane and a second agent against the same task.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const first = SessionViewSchema.parse(JSON.parse((await subject.dispatch(startRequest(startBody()))).body));
    const retried = await subject.dispatch(startRequest(startBody()));

    // Assert
    should(retried.status).equal(201);
    should(SessionViewSchema.parse(JSON.parse(retried.body)).config.id).equal(first.config.id);
  });

  it('should refuse a spent request id that carries a different start', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    await subject.dispatch(startRequest(startBody()));
    const reused = await subject.dispatch(startRequest(startBody({ prompt: 'something else entirely' })));

    // Assert
    should(reused.status).equal(409);
    should(jsonBody(reused)).have.property('code', 'request_id_reused');
  });

  it('should refuse a start that carries no request id at all', async () => {
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(startRequest(startBody(), {}));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'missing_request_id');
    // Nothing was started: the refusal happens before the subsystem is reached.
    should(control.starts).be.empty();
  });

  it('should name the missing unit for each option it cannot honour', async () => {
    // Every one of these is accepted by the protocol schema and cannot be served, so each is refused
    // with the unit that would serve it rather than accepted and silently dropped.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const board = await subject.dispatch(startRequest(startBody({ boardAccess: 'worker', parent: 's1' })));
    const attachments = await subject.dispatch(
      startRequest(startBody({ initialAttachments: [{ filename: 'brief.docx', base64: 'AAAA' }] })),
    );

    // Assert
    should([board.status, attachments.status]).deepEqual([501, 501]);
    should(jsonBody(board)).have.property('code', 'board_access_not_mounted');
    should(jsonBody(attachments)).have.property('code', 'attachments_not_mounted');
    should(control.starts).be.empty();
  });

  it('should pass a requested callsign and its fallback through to the allocator', async () => {
    // The claim is the subsystem's to take; what this mount must not do is drop the fields that say
    // which name was asked for and whether a taken one may be substituted.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(startRequest(startBody({ teammate: 'atlas', teammateFallback: true })));

    // Assert
    should(response.status).equal(201);
    should(control.requested).deepEqual([['atlas', true]]);
  });

  it('should refuse a body the protocol schema rejects without echoing it back', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    // `auto` demands a prompt: an auto session with no task can do nothing but idle.
    const promptless = await subject.dispatch(
      startRequest(JSON.stringify({ agent: 'claude-auto-loge', mode: 'auto' })),
    );
    const malformed = await subject.dispatch(startRequest('{ not json'));

    // Assert
    should(promptless.status).equal(400);
    should(jsonBody(promptless)).have.property('code', 'invalid_request');
    should(String(jsonBody(promptless).error)).containEql('prompt');
    should(malformed.status).equal(400);
    should(jsonBody(malformed)).have.property('code', 'invalid_json');
  });

  it('should restate an unknown agent as the caller mistake it is', async () => {
    // Arrange
    const control = new FakeSessionControl(['s1'], ['ghost-auto-agent']);
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(startRequest(startBody({ agent: 'ghost-auto-agent' })));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'unknown_agent');
  });

  it('should stop a session and carry the reason the caller gave', async () => {
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/stop',
        headers: human,
        body: JSON.stringify({ reason: 'the task is done' }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(SessionViewSchema.parse(JSON.parse(response.body)).state.reason).equal('the task is done');
    should(control.stops).deepEqual([['s1', 'the task is done']]);
  });

  it('should stop a session with no body at all', async () => {
    // `fy stop` sends `{}` when a human gives no reason, and a bodyless POST must mean the same.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    const response = await subject.dispatch(request({ method: 'POST', path: '/v1/sessions/s1/stop', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(control.stops).deepEqual([['s1', undefined]]);
  });

  it('should answer a stop of a session that does not exist as not found', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const absent = await subject.dispatch(request({ method: 'POST', path: '/v1/sessions/ghost/stop', headers: human }));
    const unusable = await subject.dispatch(
      request({ method: 'POST', path: '/v1/sessions/%2e%2e/stop', headers: human }),
    );

    // Assert
    should(absent.status).equal(404);
    should(jsonBody(absent)).have.property('code', 'not-found');
    // A parameter that regains a separator never reaches the service.
    should(unusable.status).equal(400);
    should(jsonBody(unusable)).have.property('code', 'invalid_session_id');
  });

  it('should let no warden-scoped caller start or stop anything', async () => {
    // A start spawns a process with the daemon's privileges; a stop kills one. Neither is readable
    // supervision, so the warden token must not reach either.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);
    const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' };

    // Act
    const started = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions',
        headers: { ...warden, [FY_REQUEST_ID_HEADER]: REQUEST_ID },
        body: startBody(),
      }),
    );
    const stopped = await subject.dispatch(request({ method: 'POST', path: '/v1/sessions/s1/stop', headers: warden }));

    // Assert
    should([started.status, stopped.status]).deepEqual([403, 403]);
    should(control.starts).be.empty();
    should(control.stops).be.empty();
  });
  it('should answer the recovery read with the session that request id started', async () => {
    // The third step of the retry contract: the client posted, retried, and both attempts failed in
    // transport. A start whose answer was lost may well have succeeded, and without this the human is
    // handed a transport error beside a session they never learn is running.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);
    const body = startBody();

    // Act
    const started = SessionViewSchema.parse(JSON.parse((await subject.dispatch(startRequest(body))).body));
    const recovered = await subject.dispatch(recoveryRequest(REQUEST_ID, fakePayloadDigest(body)));

    // Assert
    should(recovered.status).equal(200);
    should(SessionViewSchema.parse(JSON.parse(recovered.body)).config.id).equal(started.config.id);
  });

  it('should refuse a recovery read that cannot prove which body it sent', async () => {
    // The digest is the AUTHORIZATION, not an optimisation: a logical request id travels in a header
    // and is chosen by the client, so answering it on its own would let any holder of the admin token
    // enumerate other callers ids and learn which sessions they started.
    // Arrange
    const control = new FakeSessionControl();
    const subject = dispatcher(control);

    // Act
    await subject.dispatch(startRequest(startBody()));
    const noDigest = await subject.dispatch(
      request({ method: 'GET', path: `/v1/sessions/by-request/${REQUEST_ID}`, headers: human }),
    );
    const wrongDigest = await subject.dispatch(
      recoveryRequest(REQUEST_ID, fakePayloadDigest(startBody({ prompt: 'something else entirely' }))),
    );

    // Assert
    should([noDigest.status, wrongDigest.status]).deepEqual([400, 409]);
    should((JSON.parse(noDigest.body) as { code: string }).code).equal('missing_payload_digest');
    should((JSON.parse(wrongDigest.body) as { code: string }).code).equal('request_id_reused');
  });

  it('should answer a recovery read for a request id no start ever carried as not found', async () => {
    // Which is the honest answer for a start that never reached the daemon at all — the commonest
    // reason the client gets here.
    // Arrange
    const subject = dispatcher();

    // Act
    const unknown = await subject.dispatch(recoveryRequest('req-never-sent', fakePayloadDigest(startBody())));

    // Assert
    should(unknown.status).equal(404);
    should((JSON.parse(unknown.body) as { code: string }).code).equal('not-found');
  });

  it('should refuse a recovery read whose request id would regain a separator', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const traversal = await subject.dispatch(recoveryRequest('%2e%2e%2fetc', fakePayloadDigest(startBody())));

    // Assert
    should(traversal.status).equal(400);
    should((JSON.parse(traversal.body) as { code: string }).code).equal('invalid_request_id');
  });
});
