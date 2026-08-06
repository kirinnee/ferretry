import { describe, it } from 'bun:test';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { SessionAttachTargetSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { sessionAttachRoutes } from '../../../../src/lib/runtime/index.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../src/lib/session/attach/index.ts';
import type { SessionAttachSubsystem } from '../../../../src/lib/runtime/mounts/session-attach.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  ATTACH_PANE,
  ATTACH_SOCKET_PATH,
  attachSubsystem,
  CREDENTIALS,
  human,
  sessionDirectory,
  sessionView,
} from './support.ts';

/**
 * The HTTP shape of the attach proof.
 *
 * This is the only route that hands a caller a host tmux address, so three things are asserted here
 * that the domain cannot assert for itself: a caller that is not on the daemon's own machine is
 * refused BEFORE any pane is observed, an unknown session is a 404 before any evidence is gathered,
 * and every domain refusal is restated as a status a client can act on — a transiently absent pane
 * as a conflict the human can resolve, damaged durable records as the daemon's own fault.
 *
 * Nothing here may be cacheable: the proof is invalidated the instant a resume replaces the pane.
 */

/** The warden-scoped token, which must never reach this surface. */
const wardenToken = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

/** An attach subsystem that refuses in the domain's own taxonomy, or fails the way a defect does. */
class RefusingAttach implements SessionAttachSubsystem {
  /** Every session the mount asked about, so a refusal reached before the domain is visible. */
  readonly asked: string[] = [];

  constructor(private readonly failure: SessionAttachFailure | 'defect') {}

  async resolve(sessionId: string): Promise<never> {
    this.asked.push(sessionId);
    if (this.failure === 'defect') throw new Error('the pane registry file is unreadable');
    throw new SessionAttachError(this.failure, `session ${sessionId} cannot be attached`);
  }
}

function fixture(attach: SessionAttachSubsystem = attachSubsystem()) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionAttachRoutes(attach, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

/** Every request this surface serves comes from a client on the daemon's own host. */
const local = { path: '/v1/sessions/s1/attach', headers: human, loopback: true } as const;

describe('the session attach route', () => {
  it('should serve the proved target in the protocol envelope', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(local);

    // Assert — parsed with the protocol's OWN schema, so a mount that answered with a relative socket
    // path or a pane id the wire refuses cannot pass here.
    should(response.status).equal(200);
    should(SessionAttachTargetSchema.parse(jsonBody(response))).deepEqual({
      socketPath: ATTACH_SOCKET_PATH,
      tmuxSession: ATTACH_PANE.tmuxSession,
      paneId: ATTACH_PANE.paneId,
      pid: ATTACH_PANE.pid,
      processStartTicks: ATTACH_PANE.processStartTicks,
    });
    // A resume replaces the pane and invalidates this immediately; a cached copy would send a human
    // to a process that no longer exists.
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should refuse a caller that is not on the daemon host before it observes anything', async () => {
    // Arrange
    const attach = new RefusingAttach('pane_unavailable');
    const dispatch = fixture(attach);

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/attach', headers: human });

    // Assert — a filesystem socket path means nothing to a remote client, and handing one over could
    // point it at a coincidentally identical path on a different machine.
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'forbidden');
    should(attach.asked).deepEqual([]);
  });

  it('should answer 404 for a session the daemon does not hold', async () => {
    // Arrange
    const attach = new RefusingAttach('missing_registration');
    const dispatch = fixture(attach);

    // Act
    const response = await dispatch({ ...local, path: '/v1/sessions/other/attach' });

    // Assert — without this, an unknown id and a live session with no pane would both read as a
    // registration conflict, and the domain would be asked about a session that does not exist.
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
    should(attach.asked).deepEqual([]);
  });

  it('should refuse a path parameter that is not usable as an id', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ ...local, path: '/v1/sessions/%2f/attach' });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should restate a transient pane refusal as a conflict the human can resolve', async () => {
    // Arrange
    const cases: readonly SessionAttachFailure[] = ['missing_registration', 'pane_unavailable', 'identity_mismatch'];

    // Act
    const answered = [];
    for (const failure of cases) answered.push(await fixture(new RefusingAttach(failure))(local));

    // Assert — all three are states a resume fixes, so none of them is the daemon reporting a defect.
    should(answered.map(response => response.status)).deepEqual([409, 409, 409]);
    should(answered.map(response => jsonBody(response).code)).deepEqual([
      'attach_registration_missing',
      'attach_pane_unavailable',
      'attach_identity_mismatch',
    ]);
  });

  it('should report damaged durable records as the daemon fault they are', async () => {
    // Arrange
    const cases: readonly SessionAttachFailure[] = ['ambiguous_registration', 'invalid_registration'];

    // Act
    const answered = [];
    for (const failure of cases) answered.push(await fixture(new RefusingAttach(failure))(local));

    // Assert — two registrations for one session, or one with no complete identity, is state no
    // caller produced and no retry mends.
    should(answered.map(response => response.status)).deepEqual([500, 500]);
    should(answered.map(response => jsonBody(response).code)).deepEqual([
      'attach_registration_ambiguous',
      'attach_registration_invalid',
    ]);
  });

  it('should not dress an unexpected failure up as an attach refusal', async () => {
    // Arrange
    const dispatch = fixture(new RefusingAttach('defect'));

    // Act
    const response = await dispatch(local);

    // Assert — a refusal code a client can branch on must mean the domain actually said it.
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'internal_error');
    should(JSON.stringify(jsonBody(response))).not.containEql('pane registry');
  });

  it('should not serve the warden', async () => {
    // Arrange
    const attach = new RefusingAttach('pane_unavailable');
    const dispatch = fixture(attach);

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/attach', headers: wardenToken, loopback: true });

    // Assert — this hands a caller an interactive terminal, which is the human operator's authority.
    should(response.status).equal(403);
    should(attach.asked).deepEqual([]);
  });

  it('should refuse an anonymous caller even from the daemon host', async () => {
    // Arrange
    const attach = new RefusingAttach('pane_unavailable');
    const dispatch = fixture(attach);

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/attach', loopback: true });

    // Assert — loopback is a necessary condition, never a sufficient one: every process on the host
    // shares it, including the agents the daemon runs.
    should(response.status).equal(401);
    should(attach.asked).deepEqual([]);
  });
});
