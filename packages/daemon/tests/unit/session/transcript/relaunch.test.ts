import { describe, it } from 'bun:test';
import should from 'should';
import { relaunchCommand } from '../../../../src/lib/session/transcript/index.ts';

const WRAPPER = '/fleet/bin/claude-auto-loge';
const SESSION = '0f7f4a1c-1111-2222-3333-444455556666';

describe('relaunchCommand', () => {
  it('should resume the harness session once the harness has written its transcript', () => {
    // Arrange: re-running `--session-id` would ask the harness to create an id it already has.
    const command = [WRAPPER, '--session-id', SESSION, '--model', 'claude-opus-5'];

    // Act
    const relaunch = relaunchCommand(command, true);

    // Assert
    should(relaunch).eql([WRAPPER, '--resume', SESSION, '--model', 'claude-opus-5']);
  });

  it('should still create the session when the harness never wrote anything', () => {
    // Arrange: a start whose harness died before its first record is relaunched, not resumed.
    const command = [WRAPPER, '--session-id', SESSION];

    // Act
    const relaunch = relaunchCommand(command, false);

    // Assert
    should(relaunch).eql(command);
  });

  it('should leave an argv that names no harness session alone', () => {
    // Arrange: Codex names its own session, so its argv carries neither flag.
    const command = ['/fleet/bin/codex-auto-terra', '--dangerously-bypass-approvals-and-sandbox'];

    // Act / Assert
    should(relaunchCommand(command, true)).eql(command);
  });

  it('should never rewrite the wrapper itself', () => {
    // Arrange: the launch authorization pins argv[0], and a wrapper could be named anything.
    const command = ['--session-id', SESSION];

    // Act / Assert
    should(relaunchCommand(command, true)).eql(command);
  });
});
