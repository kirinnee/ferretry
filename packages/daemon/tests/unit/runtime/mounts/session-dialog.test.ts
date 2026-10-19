import { describe, it } from 'bun:test';
import { type HarnessDialogAnswerRequest, HarnessDialogAnswerResultSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type SessionDialogSubsystem, sessionDialogRoutes } from '../../../../src/lib/runtime/mounts/session-dialog.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../src/lib/session/attach/index.ts';
import { DialogAnswerError } from '../../../../src/lib/session/dialog/index.ts';
import { parseHarnessDialog } from '../../../../src/lib/tmux/harness-dialog.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  ATTACH_PANE,
  CREDENTIALS,
  DIALOG_FRAME,
  DIALOG_MOVED_FRAME,
  dialogSubsystem,
  GRANTED,
  human,
  type PermissionTmux,
  permissionTmux,
  sessionDirectory,
  sessionView,
} from './support.ts';

/**
 * THE DIALOG ROUTE, over the REAL dialog, Console, pane-capture and attach services with only tmux
 * scripted — the shape of `session-permission.test.ts`.
 *
 * Who may call it is the authorization boundary's question, proved end to end in `unlock-gate.test.ts`.
 * What is asserted here is what the route itself owes: the keys reach the pane the attach proof names,
 * Enter is pressed only after the cursor arrived, a dialog that moved on is never answered, and every
 * refusal is a status a client can act on.
 */

const SHOWN = parseHarnessDialog(DIALOG_FRAME);
const DIALOG_ID = SHOWN?.id ?? 'not-parsed';

function fixture(subsystem: SessionDialogSubsystem = dialogSubsystem()) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionDialogRoutes(subsystem, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    GRANTED,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const answering = (body: unknown, path = '/v1/sessions/s1/dialog') =>
  ({ method: 'POST', path, headers: human, loopback: true, body: JSON.stringify(body) }) as const;

const choice = (number: number, dialogId = DIALOG_ID): HarnessDialogAnswerRequest => ({
  kind: 'choice',
  dialogId,
  number,
});

/** A dialog subsystem that refuses in the domain's own taxonomy, or fails like a defect. */
class RefusingDialog implements SessionDialogSubsystem {
  constructor(private readonly failure: SessionAttachFailure | 'defect') {}

  async answer(sessionId: string): Promise<never> {
    if (this.failure === 'defect') throw new Error('the pane registry file is unreadable');
    throw new SessionAttachError(this.failure, `session ${sessionId} cannot be answered`);
  }
}

describe('the session dialog route', () => {
  it('should read the real fixtures as one dialog with the cursor on different rows', () => {
    // Assert — the premise every case below leans on.
    should(SHOWN?.options).have.length(3);
    should(SHOWN?.selected).equal(1);
    should(parseHarnessDialog(DIALOG_MOVED_FRAME)).have.property('id', DIALOG_ID);
    should(parseHarnessDialog(DIALOG_MOVED_FRAME)).have.property('selected', 2);
  });

  it('should press Enter alone for the row the cursor is on, to the proved pane, and answer that it cleared', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux, [DIALOG_FRAME, '  done\n\n› \n']));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert — `-H` means tmux interprets nothing.
    should(response.status).equal(200);
    should(HarnessDialogAnswerResultSchema.parse(jsonBody(response))).deepEqual({ dialogId: DIALOG_ID, cleared: true });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, '0d']]);
    should(tmux.captures.every(command => command.includes(ATTACH_PANE.paneId))).be.true();
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should move the cursor with an arrow, wait for it to arrive, and only then press Enter', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(2)));

    // Assert — Down (1b 5b 42), then Enter (0d), as two writes.
    should(jsonBody(response)).deepEqual({ dialogId: DIALOG_ID, cleared: true });
    should(tmux.commands.map(command => command.slice(4).join(' '))).deepEqual(['1b 5b 42', '0d']);
  });

  it('should write Escape for an escape the footer offers', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux, [DIALOG_FRAME, '  done\n\n› \n']));

    // Act
    const response = await dispatch(answering({ kind: 'escape', dialogId: DIALOG_ID }));

    // Assert
    should(jsonBody(response)).deepEqual({ dialogId: DIALOG_ID, cleared: true });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, '1b']]);
  });

  it('should answer cleared:false when the same dialog is still up after Enter', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux, [DIALOG_FRAME]));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert — reported, never answered twice.
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ dialogId: DIALOG_ID, cleared: false });
    should(tmux.commands).have.length(1);
  });

  it('should answer 409 harness_dialog_gone for a stale dialog id, and send no key', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(1, '0123456789abcdef')));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'harness_dialog_gone');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 409 harness_dialog_gone when the pane shows no dialog at all', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux, ['❯ \n']));

    // Act
    const response = await dispatch(answering(choice(1)));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'harness_dialog_gone');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 400 invalid_dialog_choice for a number the dialog did not offer, and send no key', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(9)));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_dialog_choice');
    should(tmux.commands).deepEqual([]);
  });

  it('should answer 404 for a session the daemon does not hold, before tmux is touched', async () => {
    // Arrange
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({}, tmux));

    // Act
    const response = await dispatch(answering(choice(1), '/v1/sessions/other/dialog'));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
    should([tmux.commands, tmux.captures]).deepEqual([[], []]);
  });

  it('should refuse an unusable session id and a body the wire does not accept', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const badId = await dispatch(answering(choice(1), '/v1/sessions/%2f/dialog'));
    const empty = await dispatch(answering({}));
    const noNumber = await dispatch(answering({ kind: 'choice', dialogId: DIALOG_ID }));
    const badDialogId = await dispatch(answering({ kind: 'escape', dialogId: 'nope' }));
    const extra = await dispatch(answering({ kind: 'escape', dialogId: DIALOG_ID, note: 'x' }));

    // Assert
    should(badId.status).equal(400);
    should(jsonBody(badId)).have.property('code', 'invalid_session_id');
    should([empty, noNumber, badDialogId, extra].map(response => response.status)).deepEqual([400, 400, 400, 400]);
  });

  it('should refuse a pane whose identity no longer matches, and never fall back to a session name', async () => {
    // Arrange — the registered pane was replaced: same session, a different process.
    const tmux = permissionTmux();
    const dispatch = fixture(dialogSubsystem({ observation: { ...ATTACH_PANE, pid: 5_151 } }, tmux));

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
    for (const failure of cases) answered.push(await fixture(new RefusingDialog(failure))(answering(choice(1))));

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
    const refused = await fixture(dialogSubsystem({}, refusing))(answering(choice(1)));
    const unexplained = await fixture(dialogSubsystem({}, silent))(answering(choice(1)));
    const defect = await fixture(new RefusingDialog('defect'))(answering(choice(1)));

    // Assert
    should(refused.status).equal(409);
    should(jsonBody(refused)).have.property('code', 'console_input_failed');
    should(String(jsonBody(refused).error)).match(/can't find pane: %7$/u);
    should(String(jsonBody(unexplained).error)).match(/tmux exited 1$/u);
    should(defect.status).equal(500);
  });

  it('should map a refusal raised by the service itself, whichever it is', async () => {
    // Arrange
    const raising = (refusal: 'gone' | 'invalid_choice'): SessionDialogSubsystem => ({
      answer: async () => {
        throw new DialogAnswerError(refusal, 'refused');
      },
    });

    // Act
    const gone = await fixture(raising('gone'))(answering(choice(1)));
    const invalid = await fixture(raising('invalid_choice'))(answering(choice(1)));

    // Assert
    should([gone, invalid].map(response => [response.status, jsonBody(response).code])).deepEqual([
      [409, 'harness_dialog_gone'],
      [400, 'invalid_dialog_choice'],
    ]);
  });
});
