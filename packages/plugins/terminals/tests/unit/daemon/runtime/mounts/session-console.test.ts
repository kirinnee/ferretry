import { describe, it } from 'bun:test';
import { SessionConsoleInputResultSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  sessionConsoleRoutes,
  type SessionConsoleSubsystem,
} from '../../../../src/lib/runtime/mounts/session-console-input.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../src/lib/session/attach/index.ts';
import { TERMINAL_INPUT_CHUNK_BYTES } from '../../../../src/lib/terminal/runtime-policy.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  ATTACH_PANE,
  type ConsoleTmux,
  consoleSubsystem,
  consoleTmux,
  CREDENTIALS,
  GRANTED,
  human,
  sessionDirectory,
  sessionView,
} from './support.ts';

/**
 * THE CONSOLE'S INPUT ROUTE, over the REAL Console and attach services with only tmux replaced.
 *
 * Who may call it is the authorization boundary's question, asked from the route's `terminal.use`
 * declaration and proved end to end in `unlock-gate.test.ts`. What is asserted here is what the route
 * itself owes: the bytes reach the pane the attach proof names and nothing else, an unknown session
 * is a 404 before tmux is touched, and every refusal is a status a client can act on.
 */

function fixture(pane: SessionConsoleSubsystem = consoleSubsystem()) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionConsoleRoutes(pane, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    GRANTED,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const typing = (data: unknown, path = '/v1/sessions/s1/console/input') =>
  ({ method: 'POST', path, headers: human, loopback: true, body: JSON.stringify({ data }) }) as const;

const hex = (text: string): string[] =>
  [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0'));

/** A Console whose pane proof refuses in the attach domain's own taxonomy, or fails like a defect. */
class RefusingConsole implements SessionConsoleSubsystem {
  constructor(private readonly failure: SessionAttachFailure | 'defect') {}

  async write(sessionId: string): Promise<never> {
    if (this.failure === 'defect') throw new Error('the pane registry file is unreadable');
    throw new SessionAttachError(this.failure, `session ${sessionId} cannot be typed into`);
  }
}

describe('the session Console input route', () => {
  it('should write the exact bytes to the proved pane, as hex, and answer only how many', async () => {
    // Arrange
    const tmux = consoleTmux();
    const dispatch = fixture(consoleSubsystem({}, tmux));

    // Act
    const response = await dispatch(typing('ls -la\r'));

    // Assert — `-H` means tmux interprets nothing: a `;` or a key name is typed, never run.
    should(response.status).equal(200);
    should(SessionConsoleInputResultSchema.parse(jsonBody(response))).deepEqual({ written: 7 });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, ...hex('ls -la\r')]]);
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should count UTF-8 bytes, not characters, and split a long paste into ordered chunks', async () => {
    // Arrange
    const tmux = consoleTmux();
    const dispatch = fixture(consoleSubsystem({}, tmux));
    const paste = `é${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES)}`;

    // Act
    const response = await dispatch(typing(paste));

    // Assert
    should(jsonBody(response)).deepEqual({ written: TERMINAL_INPUT_CHUNK_BYTES + 2 });
    should(tmux.commands.map(command => command.length - 4)).deepEqual([TERMINAL_INPUT_CHUNK_BYTES, 2]);
    should(tmux.commands.flatMap(command => command.slice(4))).deepEqual(hex(paste));
  });

  it('should answer 404 for a session the daemon does not hold, before tmux is touched', async () => {
    // Arrange
    const tmux = consoleTmux();
    const dispatch = fixture(consoleSubsystem({}, tmux));

    // Act
    const response = await dispatch(typing('x', '/v1/sessions/other/console/input'));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
    should(tmux.commands).deepEqual([]);
  });

  it('should refuse an unusable session id and a body the wire does not accept', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const badId = await dispatch(typing('x', '/v1/sessions/%2f/console/input'));
    const empty = await dispatch(typing(''));
    const missing = await dispatch({ ...typing('x'), body: '{}' });

    // Assert
    should(badId.status).equal(400);
    should(jsonBody(badId)).have.property('code', 'invalid_session_id');
    should([empty.status, missing.status]).deepEqual([400, 400]);
  });

  it('should refuse a pane whose identity no longer matches, and never fall back to a session name', async () => {
    // Arrange — the registered pane was replaced: same session, a different process.
    const tmux = consoleTmux();
    const dispatch = fixture(consoleSubsystem({ observation: { ...ATTACH_PANE, pid: 5_151 } }, tmux));

    // Act
    const response = await dispatch(typing('x'));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'attach_identity_mismatch');
    should(tmux.commands).deepEqual([]);
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
    for (const failure of cases) answered.push(await fixture(new RefusingConsole(failure))(typing('x')));

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
    const tmux: ConsoleTmux = { ...consoleTmux(), code: 1, stderr: "can't find pane: %7\n" };
    const silent: ConsoleTmux = { ...consoleTmux(), code: 1 };

    // Act
    const refused = await fixture(consoleSubsystem({}, tmux))(typing('x'));
    const unexplained = await fixture(consoleSubsystem({}, silent))(typing('x'));
    const defect = await fixture(new RefusingConsole('defect'))(typing('x'));

    // Assert
    should(refused.status).equal(409);
    should(jsonBody(refused)).have.property('code', 'console_input_failed');
    should(String(jsonBody(refused).error)).match(/can't find pane: %7$/u);
    should(String(jsonBody(unexplained).error)).match(/tmux exited 1$/u);
    should(defect.status).equal(500);
  });
});
