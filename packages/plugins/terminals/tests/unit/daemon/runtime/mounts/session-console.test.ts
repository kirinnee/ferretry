import { describe, it } from 'bun:test';
import should from 'should';
import { SessionConsoleInputResultSchema } from '../../../../../daemon/lib/protocol/session-processes.ts';
import {
  consoleInputHandler,
  type SessionConsoleSubsystem,
} from '../../../../../daemon/lib/runtime/mounts/session-console-input.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../../daemon/lib/session/attach/index.ts';
import { TERMINAL_INPUT_CHUNK_BYTES } from '../../../../../daemon/lib/terminal/runtime-policy.ts';
import {
  ATTACH_PANE,
  answer,
  type ConsoleTmux,
  consoleSubsystem,
  consoleTmux,
  ferretDirectory,
} from './processes-support.ts';

/**
 * THE CONSOLE'S INPUT ROUTE, over the REAL Console and attach services with only tmux replaced.
 *
 * Who may call it is the descriptor's (`terminal.use`, operator, a person). What is asserted here is what the
 * handler itself owes: the bytes reach the pane the attach proof names and nothing else, an unknown ferret is a 404
 * before tmux is touched, and every refusal is a status a client can act on.
 */

const typing = async (pane: SessionConsoleSubsystem, data: unknown, ferretId = 's1', body?: string) =>
  await answer(consoleInputHandler(pane, ferretDirectory()), {
    params: { ferretId },
    body: body ?? JSON.stringify({ data }),
  });

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

describe('the ferret Console input route', () => {
  it('should write the exact bytes to the proved pane, as hex, and answer only how many', async () => {
    // Arrange
    const tmux = consoleTmux();

    // Act
    const response = await typing(consoleSubsystem({}, tmux), 'ls -la\r');

    // Assert — `-H` means tmux interprets nothing: a `;` or a key name is typed, never run.
    should(response.status).equal(200);
    should(SessionConsoleInputResultSchema.parse(response.body)).deepEqual({ written: 7 });
    should(tmux.commands).deepEqual([['send-keys', '-H', '-t', ATTACH_PANE.paneId, ...hex('ls -la\r')]]);
  });

  it('should count UTF-8 bytes, not characters, and split a long paste into ordered chunks', async () => {
    // Arrange
    const tmux = consoleTmux();
    const paste = `é${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES)}`;

    // Act
    const response = await typing(consoleSubsystem({}, tmux), paste);

    // Assert
    should(response.body).deepEqual({ written: TERMINAL_INPUT_CHUNK_BYTES + 2 });
    should(tmux.commands.map(command => command.length - 4)).deepEqual([TERMINAL_INPUT_CHUNK_BYTES, 2]);
    should(tmux.commands.flatMap(command => command.slice(4))).deepEqual(hex(paste));
  });

  it('should answer 404 for a ferret the daemon does not hold, before tmux is touched', async () => {
    // Arrange
    const tmux = consoleTmux();

    // Act
    const response = await typing(consoleSubsystem({}, tmux), 'x', 'other');

    // Assert
    should([response.status, response.code]).deepEqual([404, 'not-found']);
    should(tmux.commands).deepEqual([]);
  });

  it('should refuse an unusable ferret id and a body the wire does not accept', async () => {
    // Arrange
    const pane = consoleSubsystem();

    // Act
    const badId = await typing(pane, 'x', '%2f');
    const empty = await typing(pane, '');
    const missing = await typing(pane, 'x', 's1', '{}');

    // Assert
    should([badId.status, badId.code]).deepEqual([400, 'invalid_session_id']);
    should([empty.status, missing.status]).deepEqual([400, 400]);
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
    for (const failure of cases) answered.push(await typing(new RefusingConsole(failure), 'x'));

    // Assert
    should(answered.map(response => [response.status, response.code])).deepEqual([
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
    const refused = await typing(consoleSubsystem({}, tmux), 'x');
    const unexplained = await typing(consoleSubsystem({}, silent), 'x');

    // Assert
    should([refused.status, refused.code]).deepEqual([409, 'console_input_failed']);
    should(String(refused.error)).match(/can't find pane: %7$/u);
    should(String(unexplained.error)).match(/tmux exited 1$/u);
    await should(typing(new RefusingConsole('defect'), 'x')).be.rejectedWith('the pane registry file is unreadable');
  });
});
