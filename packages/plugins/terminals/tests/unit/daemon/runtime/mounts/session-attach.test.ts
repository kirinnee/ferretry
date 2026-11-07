import { describe, it } from 'bun:test';
import should from 'should';
import manifest from '../../../../../manifest.ts';
import { SessionAttachTargetSchema } from '../../../../../daemon/lib/protocol/session-processes.ts';
import { attachHandler, type SessionAttachSubsystem } from '../../../../../daemon/lib/runtime/mounts/session-attach.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../../daemon/lib/session/attach/index.ts';
import { ATTACH_PANE, ATTACH_SOCKET_PATH, answer, attachSubsystem, ferretDirectory } from './processes-support.ts';

/**
 * The HTTP shape of the attach proof.
 *
 * This is the only route that hands a caller a host tmux address. Who may ask is the descriptor's: a person, an
 * operator credential, over the privileged local listener, never cached. What the handler owes: an unknown ferret is
 * a 404 before any evidence is gathered, and every domain refusal is restated as a status a client can act on — a
 * transiently absent pane as a conflict the human can resolve, damaged records as the daemon's own fault.
 */

/** An attach subsystem that refuses in the domain's own taxonomy, or fails the way a defect does. */
class RefusingAttach implements SessionAttachSubsystem {
  /** Every ferret the handler asked about, so a refusal reached before the domain is visible. */
  readonly asked: string[] = [];

  constructor(private readonly failure: SessionAttachFailure | 'defect') {}

  async resolve(sessionId: string): Promise<never> {
    this.asked.push(sessionId);
    if (this.failure === 'defect') throw new Error('the pane registry file is unreadable');
    throw new SessionAttachError(this.failure, `session ${sessionId} cannot be attached`);
  }
}

const attach = async (subsystem: SessionAttachSubsystem = attachSubsystem(), ferretId = 's1') =>
  await answer(attachHandler(subsystem, ferretDirectory()), { params: { ferretId } });

describe('the ferret attach route', () => {
  it('should be declared for a person at this machine only, never cached', () => {
    // Arrange / Act
    const declared = manifest.actions.routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/attach');

    // Assert — a filesystem socket path means nothing to a remote client, and this hands a caller an interactive
    // terminal, which is the human operator's authority (a ferret or the Warden may not have it).
    should(declared).containDeep({ minimum: 'operator', caller: 'person', privilegedOnly: true, noStore: true });
  });

  it('should serve the proved target in the protocol envelope', async () => {
    // Act
    const response = await attach();

    // Assert — parsed with the protocol's OWN schema, so a handler that answered with a relative socket path or a
    // pane id the wire refuses cannot pass here.
    should(response.status).equal(200);
    should(SessionAttachTargetSchema.parse(response.body)).deepEqual({
      socketPath: ATTACH_SOCKET_PATH,
      tmuxSession: ATTACH_PANE.tmuxSession,
      paneId: ATTACH_PANE.paneId,
      pid: ATTACH_PANE.pid,
      processStartTicks: ATTACH_PANE.processStartTicks,
    });
  });

  it('should answer 404 for a ferret the daemon does not hold', async () => {
    // Arrange
    const refusing = new RefusingAttach('missing_registration');

    // Act
    const response = await attach(refusing, 'other');

    // Assert — without this, an unknown id and a live ferret with no pane would both read as a registration
    // conflict, and the domain would be asked about a ferret that does not exist.
    should([response.status, response.code]).deepEqual([404, 'not-found']);
    should(refusing.asked).deepEqual([]);
  });

  it('should refuse a path parameter that is not usable as an id', async () => {
    // Act
    const response = await attach(attachSubsystem(), '%2f');

    // Assert
    should([response.status, response.code]).deepEqual([400, 'invalid_session_id']);
  });

  it('should restate a transient pane refusal as a conflict the human can resolve', async () => {
    // Arrange
    const cases: readonly SessionAttachFailure[] = ['missing_registration', 'pane_unavailable', 'identity_mismatch'];

    // Act
    const answered = [];
    for (const failure of cases) answered.push(await attach(new RefusingAttach(failure)));

    // Assert — all three are states a resume fixes, so none of them is the daemon reporting a defect.
    should(answered.map(response => [response.status, response.code])).deepEqual([
      [409, 'attach_registration_missing'],
      [409, 'attach_pane_unavailable'],
      [409, 'attach_identity_mismatch'],
    ]);
  });

  it('should report damaged records as the daemon fault they are', async () => {
    // Arrange
    const cases: readonly SessionAttachFailure[] = ['ambiguous_registration', 'invalid_registration'];

    // Act
    const answered = [];
    for (const failure of cases) answered.push(await attach(new RefusingAttach(failure)));

    // Assert
    should(answered.map(response => [response.status, response.code])).deepEqual([
      [500, 'attach_registration_ambiguous'],
      [500, 'attach_registration_invalid'],
    ]);
  });

  it('should not dress an unexpected failure up as an attach refusal', async () => {
    // Act / Assert — a refusal code a client can branch on must mean the domain actually said it; the kernel answers
    // anything else as its own 500, without the message.
    await should(attach(new RefusingAttach('defect'))).be.rejectedWith('the pane registry file is unreadable');
  });
});
