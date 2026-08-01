import { describe, it } from 'bun:test';
import { SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionSignalError, sessionSignalRoutes } from '../../../../src/lib/runtime/mounts/session-signal.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeSessionSignal, human } from './support.ts';

/**
 * The surface a session speaks about itself through.
 *
 * Every case goes through the real dispatcher and the real credentials, because what this mount owes
 * the domain is a validated request from an authorized caller — and the authorization is the part that
 * cannot be checked by calling the route function directly.
 */

function dispatcher(subsystem = new FakeSessionSignal()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionSignalRoutes(subsystem)), CREDENTIALS);
}

function signalRequest(
  sessionId: string,
  body: string,
  headers: Readonly<Record<string, string>> = human,
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/signal`, headers, body });
}

describe('the session signal mount', () => {
  it('should record a completion and answer with the view the read surface serves', async () => {
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'done', message: 'shipped' })));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a signal that failed.
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.config.id).equal('s1');
    // The status moved to the one only this surface can write.
    should(view.state.status).equal('completed');
    should(sessions.signals).deepEqual([['s1', { kind: 'done', message: 'shipped' }]]);
  });

  it('should pass every wait field through untouched', async () => {
    // A park with a deadline and a park without one are different sessions to a supervisor: one is
    // woken on time and the other waits for the backstop. Dropping `until` at the boundary would turn
    // the first silently into the second.
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(
      signalRequest('s1', JSON.stringify({ kind: 'waiting', until: '45m', condition: 'CI run', peer: 'hayden' })),
    );

    // Assert
    should(response.status).equal(200);
    should(sessions.signals).deepEqual([
      ['s1', { kind: 'waiting', until: '45m', condition: 'CI run', peer: 'hayden' }],
    ]);
  });

  it('should accept the three kinds whose message is optional and refuse a help with none', async () => {
    // `help` is the one kind whose message IS the request: a question with no text is nothing to ask.
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const done = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'done' })));
    const waiting = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'waiting' })));
    const working = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'working' })));
    const help = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'help' })));

    // Assert
    should([done.status, waiting.status, working.status]).deepEqual([200, 200, 200]);
    should(help.status).equal(400);
    should(sessions.signals.map(([, sent]) => sent.kind)).deepEqual(['done', 'waiting', 'working']);
  });

  it('should require a body, because there is no safe default among the four kinds', async () => {
    // The revive's body is optional and this one is not: an absent `kind` would have to be given a
    // meaning, and "finish", "ask a human", "park" and "carry on" have no common default.
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const empty = await subject.dispatch(signalRequest('s1', ''));
    const braces = await subject.dispatch(signalRequest('s1', '{}'));
    const malformed = await subject.dispatch(signalRequest('s1', '{'));

    // Assert
    should(empty.status).equal(400);
    should(braces.status).equal(400);
    should((JSON.parse(malformed.body) as { code: string }).code).equal('invalid_json');
    should(sessions.signals).be.empty();
  });

  it('should refuse a kind the protocol does not name and a field it does not declare', async () => {
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const invented = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'finished' })));
    // `until` on a `working` signal: the strict object refuses it rather than ignoring it, so a
    // teammate that meant to park cannot be told its unbounded wait was accepted.
    const misplaced = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'working', until: '45m' })));

    // Assert
    should(invented.status).equal(400);
    should(misplaced.status).equal(400);
    should(sessions.signals).be.empty();
  });

  it('should refuse anonymously and refuse a warden token, because a signal retires panes', async () => {
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const anonymous = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'done' }), {}));
    const warden = await subject.dispatch(
      signalRequest('s1', JSON.stringify({ kind: 'done' }), {
        authorization: `Bearer ${CREDENTIALS.warden}`,
      }),
    );

    // Assert
    should(anonymous.status).equal(401);
    // `admin` scope, matching the stop and the revive: a warden TOKEN does not get to complete a session.
    should(warden.status).equal(403);
    // Neither request reached the subsystem at all, which is what "fails closed" has to mean.
    should(sessions.signals).be.empty();
  });

  it('should serve a teammate calling from inside its own pane, which is the ordinary caller here', async () => {
    // Unlike the revive, this route reads no actor: what a session says about ITSELF does not depend
    // on which token class asked, only on whether the caller is authorized at all. A peer token holds
    // admin scope in this daemon, and `kteam signal done` is exactly that call.
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'working' }), agentIn('s1')));

    // Assert
    should(response.status).equal(200);
    should(sessions.signals).deepEqual([['s1', { kind: 'working' }]]);
  });

  it('should answer each refusal the signal domain raises with its own status and code', async () => {
    // The refusals are deliberately not collapsed: they are different next actions for a caller — fix
    // the request, revive the session, name a peer that exists — and one status would make a client
    // guess which.
    // Arrange
    const subject = dispatcher(
      new FakeSessionSignal(['s1'], {
        parked: new SessionSignalError('refused', 'session parked is stopped; resume it before declaring a wait'),
        typo: new SessionSignalError('unknown_peer', 'unknown session "haydn"'),
        clumsy: new SessionSignalError('invalid', 'until must be a positive duration'),
        broken: new SessionSignalError('failed', 'the pane could not be retired'),
      }),
    );

    // Act
    const answers = await Promise.all(
      ['parked', 'typo', 'clumsy', 'broken', 'absent'].map(
        async id => await subject.dispatch(signalRequest(id, JSON.stringify({ kind: 'waiting' }))),
      ),
    );

    // Assert
    should(answers.map(response => [response.status, (JSON.parse(response.body) as { code: string }).code])).deepEqual([
      [409, 'signal_refused'],
      // 404, not 400: the request is well formed and the thing it names is simply not here.
      [404, 'unknown_peer'],
      [400, 'invalid_request'],
      [500, 'session_signal_failed'],
      [404, 'not-found'],
    ]);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream. An encoded separator that decoded back into one
    // must never reach the service.
    // Arrange
    const sessions = new FakeSessionSignal();
    const subject = dispatcher(sessions);

    // Act
    const traversal = await subject.dispatch(signalRequest('%2e%2e%2fetc', JSON.stringify({ kind: 'done' })));

    // Assert
    should(traversal.status).equal(400);
    should((JSON.parse(traversal.body) as { code: string }).code).equal('invalid_session_id');
    should(sessions.signals).be.empty();
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the signal domain decides, and anything else is this daemon being broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionSignal(['s1'], {
        // Not a SessionSignalError: the cast is the point of the case.
        s1: new Error('the storage index was closed') as SessionSignalError,
      }),
    );

    // Act
    const response = await subject.dispatch(signalRequest('s1', JSON.stringify({ kind: 'done' })));

    // Assert
    should(response.status).equal(500);
    should(response.body).not.match(/storage index/u);
  });

  it('should answer with no-store, because the status is exactly what this call changed', async () => {
    // Arrange / Act
    const routes = sessionSignalRoutes(new FakeSessionSignal());

    // Assert
    should(routes).have.length(1);
    should(routes[0]?.noStore).be.true();
    should(routes[0]?.scope).equal('admin');
  });
});
