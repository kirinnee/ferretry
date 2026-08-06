import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, SendResultSchema, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionSendError, sessionSendRoutes } from '../../../../src/lib/runtime/mounts/session-send.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeSessionSend, human } from './support.ts';

/**
 * The surface a running session is spoken to through.
 *
 * Every case goes through the real dispatcher and the real credentials, because two of the facts this
 * mount passes to the domain do not come from the body at all — the idempotency key comes from a
 * header, and the SENDER comes from the credential the request authenticated with. Calling the route
 * function directly would prove neither.
 */

const withRequestId = (headers: Readonly<Record<string, string>>, id = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: id,
});

function dispatcher(subsystem = new FakeSessionSend()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionSendRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

function sendRequest(
  sessionId: string,
  body: string,
  headers: Readonly<Record<string, string>> = withRequestId(human),
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/send`, headers, body });
}

function interruptRequest(
  sessionId: string,
  body = '{}',
  headers: Readonly<Record<string, string>> = human,
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/interrupt`, headers, body });
}

describe('the session send mount', () => {
  it('should hand a message over and answer with the view plus what the transport did', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' })));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a send that failed.
    const result = SendResultSchema.parse(JSON.parse(response.body));
    should(result.config.id).equal('s1');
    should(result.disposition).equal('delivered');
    should(sessions.sends).have.length(1);
    should(sessions.sends[0]?.[1]).match({ message: 'ship it', sendId: 'req-1' });
  });

  it('should pass `now` and `replyExpected` through untouched', async () => {
    // Both change what happens to a live agent: one ends the turn it is on, and the other tells the
    // receiver somebody is blocked on the answer. Dropping either at the boundary would be silent.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    await subject.dispatch(
      sendRequest('s1', JSON.stringify({ message: 'stop and read this', now: true, replyExpected: true })),
    );

    // Assert
    should(sessions.sends[0]?.[1]).match({ now: true, replyExpected: true });
  });

  it('should take the sender from the credential, never from the body', async () => {
    // `from` decides how the message is attributed AND whose declared wait it ends, so a caller able
    // to name itself could wake any other session's park.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), withRequestId(agentIn('s2'))));
    await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), withRequestId(human, 'req-2')));

    // Assert
    should(sessions.sends[0]?.[1].senderSessionId).equal('s2');
    // The human's own CLI is not a peer, so nothing is attributed.
    should(sessions.sends[1]?.[1].senderSessionId).be.undefined();
  });

  it('should refuse a send that carries no idempotency key', async () => {
    // Without one, a retried request whose answer was lost becomes a SECOND message the agent reads
    // and acts on twice — the one write in this daemon a duplicate makes expensively wrong.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), human));

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('missing_request_id');
    should(sessions.sends).be.empty();
  });

  it('should refuse a body the protocol does not accept', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const empty = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: '' })));
    const unknown = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'hi', urgent: true })));

    // Assert
    should(empty.status).equal(400);
    should(unknown.status).equal(400);
  });

  it('should refuse a path parameter that regains a separator', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('a%2Fb', JSON.stringify({ message: 'ship it' })));

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('invalid_session_id');
    should(sessions.sends).be.empty();
  });

  it('should answer each refusal with the status its next action deserves', async () => {
    // A session that is merely still launching is a RETRY; one that is quarantined is a change of
    // plan. Collapsing them would tell an operator to fix something that is not broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionSend(['s1'], {
        pending: new SessionSendError('pending', 'still launching'),
        refused: new SessionSendError('refused', 'quarantined'),
        broken: new SessionSendError('failed', 'tmux went away'),
      }),
    );

    // Act
    const pending = await subject.dispatch(sendRequest('pending', JSON.stringify({ message: 'x' })));
    const refused = await subject.dispatch(sendRequest('refused', JSON.stringify({ message: 'x' })));
    const failed = await subject.dispatch(sendRequest('broken', JSON.stringify({ message: 'x' })));
    const missing = await subject.dispatch(sendRequest('nope', JSON.stringify({ message: 'x' })));

    // Assert
    should(pending.status).equal(503);
    should((JSON.parse(pending.body) as { code: string }).code).equal('session_launching');
    should(refused.status).equal(409);
    should(failed.status).equal(500);
    should(missing.status).equal(404);
  });

  it('should refuse an unauthenticated caller before the subsystem is reached', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const anonymous = await subject.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/send', body: JSON.stringify({ message: 'x' }) }),
    );
    const warden = await subject.dispatch(
      sendRequest('s1', JSON.stringify({ message: 'x' }), {
        authorization: `Bearer ${CREDENTIALS.warden}`,
        [FY_REQUEST_ID_HEADER]: 'req-1',
      }),
    );

    // Assert
    should(anonymous.status).equal(401);
    // A warden watches sessions; it does not type into them.
    should(warden.status).equal(403);
    should(sessions.sends).be.empty();
  });
});

describe('the session interrupt mount', () => {
  it('should stop the turn and answer with the view the read surface serves', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(interruptRequest('s1'));

    // Assert
    should(response.status).equal(200);
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.state.status).equal('interrupted');
    should(sessions.interrupts).deepEqual(['s1']);
  });

  it('should refuse a BOUND abandon rather than approximating it with a turn stop', async () => {
    // A client that names the question it means to abandon is asking for an operation this daemon
    // cannot perform. Answering 200 would report success for something that never happened, and would
    // leave the question on screen with the caller believing it was gone.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(interruptRequest('s1', JSON.stringify({ toolUseId: 'tool-7' })));

    // Assert
    should(response.status).equal(501);
    should((JSON.parse(response.body) as { code: string }).code).equal('question_abandon_unsupported');
    should(sessions.interrupts).be.empty();
  });

  it('should answer a refusal and a missing session with their own statuses', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionSend(['s1'], { refused: new SessionSendError('refused', 'nothing to interrupt') }),
    );

    // Act
    const refused = await subject.dispatch(interruptRequest('refused'));
    const missing = await subject.dispatch(interruptRequest('nope'));

    // Assert
    should(refused.status).equal(409);
    should(missing.status).equal(404);
  });
});
