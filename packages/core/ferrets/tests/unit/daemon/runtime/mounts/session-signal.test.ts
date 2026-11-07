import { describe, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import {
  SessionViewSchema,
  type SessionView,
  type SignalSessionRequest,
} from '../../../../../daemon/lib/protocol/session.ts';
import should from 'should';
import {
  SessionSignalError,
  type SessionSignalSubsystem,
  sessionSignalRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-signal.ts';
import { sessionView } from '../../../../support/daemon/session-view.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';

/**
 * The surface a session speaks about itself through.
 *
 * The handler is called directly: what this mount owes the domain is a validated request. Who may call it (the
 * route spine: minimum, caller, noStore) is the kernel's, tested over a real host in
 * tests/integration/daemon/ferrets/routes.test.ts.
 */

/** A signal surface that records instead of acting (today's `FakeSessionSignal` from the mount support file). */
class FakeSessionSignal implements SessionSignalSubsystem {
  /** Every signal that reached the subsystem, as the session and the request it carried. */
  readonly signals: Array<readonly [string, SignalSessionRequest]> = [];

  constructor(
    /** Sessions that exist, so a signal has something to speak for. */
    private readonly known: readonly string[] = ['s1'],
    /** Session ids mapped to the refusal asking about them raises. */
    private readonly refusals: Readonly<Record<string, SessionSignalError>> = {},
  ) {}

  async signal(sessionId: string, request: SignalSessionRequest): Promise<SessionView> {
    this.signals.push([sessionId, request]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionSignalError('not_found', `no session ${sessionId}`);
    // The status each kind produces, because a view still reporting `running` would not distinguish a
    // completion from a read.
    const status = request.kind === 'done' ? 'completed' : request.kind === 'working' ? 'running' : 'waiting';
    return sessionView(sessionId, {}, { status });
  }
}

const SIGNAL = 'POST /v1/ferrets/:ferretId/signal';

function send(subsystem: SessionSignalSubsystem, ferretId: string, body: string) {
  return sessionSignalRoutes(subsystem)[SIGNAL](requestOf({ method: 'POST', params: { ferretId }, body }));
}

describe('the session signal mount', () => {
  it('should record a completion and answer with the view the read surface serves', async () => {
    // Arrange
    const sessions = new FakeSessionSignal();

    // Act
    const response = await send(sessions, 's1', JSON.stringify({ kind: 'done', message: 'shipped' }));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a signal that failed.
    const view = SessionViewSchema.parse(jsonOf(response));
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

    // Act
    const response = await send(
      sessions,
      's1',
      JSON.stringify({ kind: 'waiting', until: '45m', condition: 'CI run', peer: 'hayden' }),
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

    // Act
    const done = await send(sessions, 's1', JSON.stringify({ kind: 'done' }));
    const waiting = await send(sessions, 's1', JSON.stringify({ kind: 'waiting' }));
    const working = await send(sessions, 's1', JSON.stringify({ kind: 'working' }));
    const help = await refusalOf(send(sessions, 's1', JSON.stringify({ kind: 'help' })));

    // Assert
    should([done.status, waiting.status, working.status]).deepEqual([200, 200, 200]);
    should(help?.status).equal(400);
    should(sessions.signals.map(([, sent]) => sent.kind)).deepEqual(['done', 'waiting', 'working']);
  });

  it('should require a body, because there is no safe default among the four kinds', async () => {
    // The revive's body is optional and this one is not: an absent `kind` would have to be given a
    // meaning, and "finish", "ask a human", "park" and "carry on" have no common default.
    // Arrange
    const sessions = new FakeSessionSignal();

    // Act
    const empty = await refusalOf(send(sessions, 's1', ''));
    const braces = await refusalOf(send(sessions, 's1', '{}'));
    const malformed = await refusalOf(send(sessions, 's1', '{'));

    // Assert
    should(empty?.status).equal(400);
    should(braces?.status).equal(400);
    should(malformed?.code).equal('invalid_json');
    should(sessions.signals).be.empty();
  });

  it('should refuse a kind the protocol does not name and a field it does not declare', async () => {
    // Arrange
    const sessions = new FakeSessionSignal();

    // Act
    const invented = await refusalOf(send(sessions, 's1', JSON.stringify({ kind: 'finished' })));
    // `until` on a `working` signal: the strict object refuses it rather than ignoring it, so a
    // teammate that meant to park cannot be told its unbounded wait was accepted.
    const misplaced = await refusalOf(send(sessions, 's1', JSON.stringify({ kind: 'working', until: '45m' })));

    // Assert
    should(invented?.status).equal(400);
    should(misplaced?.status).equal(400);
    should(sessions.signals).be.empty();
  });

  it('should answer each refusal the signal domain raises with its own status and code', async () => {
    // The refusals are deliberately not collapsed: they are different next actions for a caller — fix
    // the request, revive the session, name a peer that exists — and one status would make a client
    // guess which.
    // Arrange
    const sessions = new FakeSessionSignal(['s1'], {
      parked: new SessionSignalError('refused', 'session parked is stopped; resume it before declaring a wait'),
      typo: new SessionSignalError('unknown_peer', 'unknown session "haydn"'),
      clumsy: new SessionSignalError('invalid', 'until must be a positive duration'),
      broken: new SessionSignalError('failed', 'the pane could not be retired'),
    });

    // Act
    const answers = await Promise.all(
      ['parked', 'typo', 'clumsy', 'broken', 'absent'].map(
        async id => await refusalOf(send(sessions, id, JSON.stringify({ kind: 'waiting' }))),
      ),
    );

    // Assert
    should(answers.map(refusal => [refusal?.status, refusal?.code])).deepEqual([
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

    // Act
    const traversal = await refusalOf(send(sessions, '%2e%2e%2fetc', JSON.stringify({ kind: 'done' })));

    // Assert
    should(traversal).deepEqual({ status: 400, code: 'invalid_session_id' });
    should(sessions.signals).be.empty();
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the signal domain decides, and anything else is this daemon being broken.
    // Arrange
    const sessions = new FakeSessionSignal(['s1'], {
      // Not a SessionSignalError: the cast is the point of the case.
      s1: new Error('the storage index was closed') as SessionSignalError,
    });

    // Act
    const thrown = await send(sessions, 's1', JSON.stringify({ kind: 'done' })).catch((error: unknown) => error);

    // Assert
    should(thrown).be.instanceOf(Error);
    should(thrown).not.be.instanceOf(ApiError);
  });
});
