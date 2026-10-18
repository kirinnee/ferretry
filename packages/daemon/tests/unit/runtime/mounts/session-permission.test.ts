import { describe, it } from 'bun:test';
import { type PermissionAnswerRequest, PermissionAnswerResultSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  type SessionPermissionSubsystem,
  sessionPermissionRoutes,
} from '../../../../src/lib/runtime/mounts/session-permission.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../src/lib/session/attach/index.ts';
import { PermissionAnswerError } from '../../../../src/lib/session/permission/index.ts';
import { parsePermissionPrompt } from '../../../../src/lib/tmux/permission-prompt.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  ATTACH_PANE,
  CREDENTIALS,
  GRANTED,
  human,
  PERMISSION_FRAME,
  type PermissionTmux,
  permissionSubsystem,
  permissionTmux,
  sessionDirectory,
  sessionView,
} from './support.ts';

/**
 * THE PERMISSION ROUTE, over the REAL permission, Console, pane-capture and attach services with only
 * tmux scripted.
 *
 * Who may call it is the authorization boundary's question, asked from the route's `terminal.use`
 * declaration and proved end to end in `unlock-gate.test.ts`. What is asserted here is what the route
 * itself owes: the one key reaches the pane the attach proof names, a prompt that moved on is never
 * answered, and every refusal is a status a client can act on.
 */

const SHOWN = parsePermissionPrompt(PERMISSION_FRAME);
const REQUEST_ID = SHOWN?.id ?? 'not-parsed';

function fixture(subsystem: SessionPermissionSubsystem = permissionSubsystem()) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionPermissionRoutes(subsystem, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    GRANTED,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const answering = (body: unknown, path = '/v1/sessions/s1/permission') =>
  ({ method: 'POST', path, headers: human, loopback: true, body: JSON.stringify(body) }) as const;

const choice = (number: number, requestId = REQUEST_ID): PermissionAnswerRequest => ({
  kind: 'choice',
  requestId,
  number,
});

/** A permission subsystem that refuses in the domain's own taxonomy, or fails like a defect. */
class RefusingPermission implements SessionPermissionSubsystem {
  constructor(private readonly failure: SessionAttachFailure | 'defect') {}

  async answer(sessionId: string): Promise<never> {
    if (this.failure === 'defect') throw new Error('the pane registry file is unreadable');
    throw new SessionAttachError(this.failure, `session ${sessionId} cannot be answered`);
  }
}

describe('the session permission route', () => {
  it('should read the real fixture as a prompt with three choices', () => {
    // Assert — the premise every case below leans on.
    should(SHOWN?.options.map(option => option.kind)).deepEqual(['allow', 'allow-always', 'deny']);
  });

  it('should write the chosen digit alone to the proved pane, as hex, and answer that it cleared', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(2)));

    // Assert — no Enter follows the digit, and `-H` means tmux interprets nothing.
    should(response.status).equal(200);
    should(PermissionAnswerResultSchema.parse(jsonBody(response))).deepEqual({ requestId: REQUEST_ID, cleared: true });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, '32']]);
    should(tmux.captures.every(command => command.includes(ATTACH_PANE.paneId))).be.true();
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should write Escape for a deny', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering({ kind: 'deny', requestId: REQUEST_ID }));

    // Assert
    should(jsonBody(response)).deepEqual({ requestId: REQUEST_ID, cleared: true });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, '1b']]);
  });

  it('should answer cleared:false when the same prompt is still up after the key', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux, [PERMISSION_FRAME]));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert — reported, never answered twice.
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ requestId: REQUEST_ID, cleared: false });
    should(tmux.commands).have.length(1);
  });

  it('should answer 409 permission_prompt_gone for a stale request id, and send no key', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(1, '0123456789abcdef')));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'permission_prompt_gone');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 409 permission_prompt_gone when the pane shows no prompt at all', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux, ['❯ \n']));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'permission_prompt_gone');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 400 invalid_permission_choice for a number the prompt did not offer, and send no key', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(9)));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_permission_choice');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 404 for a session the daemon does not hold, before tmux is touched', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(1), '/v1/sessions/other/permission'));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
    should([tmux.commands, tmux.captures]).deepEqual([[], []]);
  });

  it('should refuse an unusable session id and a body the wire does not accept', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const badId = await dispatch(answering(choice(1), '/v1/sessions/%2f/permission'));
    const empty = await dispatch(answering({}));
    const noNumber = await dispatch(answering({ kind: 'choice', requestId: REQUEST_ID }));
    const badRequestId = await dispatch(answering({ kind: 'deny', requestId: 'nope' }));
    const extra = await dispatch(answering({ kind: 'deny', requestId: REQUEST_ID, note: 'x' }));

    // Assert
    should(badId.status).equal(400);
    should(jsonBody(badId)).have.property('code', 'invalid_session_id');
    should([empty, noNumber, badRequestId, extra].map(response => response.status)).deepEqual([400, 400, 400, 400]);
  });

  it('should refuse a pane whose identity no longer matches, and never fall back to a session name', async () => {
    // Arrange — the registered pane was replaced: same session, a different process.
    const tmux = permissionTmux();
    const dispatch = fixture(permissionSubsystem({ observation: { ...ATTACH_PANE, pid: 5_151 } }, tmux));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'attach_identity_mismatch');
    should([tmux.commands, tmux.captures]).deepEqual([[], []]);
  });

  it('should restate every attach refusal with the attach route’s own status and code', async () => {
    // Arrange
    const cases: readonly SessionAttachFailure[] = [
      'missing_registration',
      'pane_unavailable',
      'identity_mismatch',
      'ambiguous_registration',
      'invalid_registration',
    ];

    // Act
    const answered = [];
    for (const failure of cases) answered.push(await fixture(new RefusingPermission(failure))(answering(choice(1))));

    // Assert
    should(answered.map(response => [response.status, jsonBody(response).code])).deepEqual([
      [409, 'attach_registration_missing'],
      [409, 'attach_pane_unavailable'],
      [409, 'attach_identity_mismatch'],
      [500, 'attach_registration_ambiguous'],
      [500, 'attach_registration_invalid'],
    ]);
  });

  it('should report keys tmux refused as a conflict, and a defect as the daemon’s own fault', async () => {
    // Arrange
    const refusing: PermissionTmux = { ...permissionTmux(), code: 1, stderr: "can't find pane: %7\n" };
    const silent: PermissionTmux = { ...permissionTmux(), code: 1 };

    // Act
    const refused = await fixture(permissionSubsystem({}, refusing))(answering(choice(1)));
    const unexplained = await fixture(permissionSubsystem({}, silent))(answering(choice(1)));
    const defect = await fixture(new RefusingPermission('defect'))(answering(choice(1)));

    // Assert
    should(refused.status).equal(409);
    should(jsonBody(refused)).have.property('code', 'console_input_failed');
    should(String(jsonBody(refused).error)).match(/can't find pane: %7$/u);
    should(String(jsonBody(unexplained).error)).match(/tmux exited 1$/u);
    should(defect.status).equal(500);
  });

  it('should treat a pane that cannot be read as the daemon’s own fault, not a refusal', async () => {
    // Arrange
    const tmux: PermissionTmux = { ...permissionTmux(), captureCode: 1 };

    // Act
    const response = await fixture(permissionSubsystem({}, tmux))(answering(choice(1)));

    // Assert
    should(response.status).equal(500);
    should(tmux.commands).deepEqual([]);
  });

  it('should map a refusal raised by the service itself, whichever it is', async () => {
    // Arrange
    const raising = (refusal: 'gone' | 'invalid_choice'): SessionPermissionSubsystem => ({
      answer: async () => {
        throw new PermissionAnswerError(refusal, 'refused');
      },
    });

    // Act
    const gone = await fixture(raising('gone'))(answering(choice(1)));
    const invalid = await fixture(raising('invalid_choice'))(answering(choice(1)));

    // Assert
    should([gone, invalid].map(response => [response.status, jsonBody(response).code])).deepEqual([
      [409, 'permission_prompt_gone'],
      [400, 'invalid_permission_choice'],
    ]);
  });
});
