/**
 * What the Warden's classifier says of the processes under a pane, for the processes the session observer's liveness
 * scenarios hand it.
 *
 * Moved from `packages/core/ferrets/tests/integration/daemon/session/observer/worker-observer-host.test.ts`
 * ("should ask a hosted session's worker, and use what it answered"), whose liveness sample carries
 * `subprocessAlive: true` and `subprocessKey: 'pid:1'` for a shell running `sleep 600`. That the sample carries what
 * the classifier says is Ferrets' to test, with a scripted classifier; what the classifier says is tested here.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type PaneProcess, paneWorkSummary } from '../../daemon/lib/pane-processes.ts';

describe('paneWorkSummary — the processes under a pane', () => {
  it('should call a shell running a command the tool command being waited on, keyed by its pid', () => {
    // Arrange
    const processes: readonly PaneProcess[] = [{ pid: 1, argv: 'bash -c sleep 600' }];

    // Act
    const actual = paneWorkSummary(processes);

    // Assert
    should(actual).deepEqual({ toolCommand: true, commandKey: 'pid:1', leftoverBrowser: false });
  });

  it('should call a pane with nothing under it idle', () => {
    // Act
    const actual = paneWorkSummary([]);

    // Assert
    should(actual).deepEqual({ toolCommand: false, leftoverBrowser: false });
  });

  it('should not count the harness or the helpers it keeps for the whole session as work', () => {
    // Arrange
    const processes: readonly PaneProcess[] = [
      { pid: 10, argv: 'claude', known: { kind: 'harness' } },
      { pid: 11, ppid: 10, argv: 'fy mcp serve', known: { kind: 'tools' } },
    ];

    // Act
    const actual = paneWorkSummary(processes);

    // Assert
    should(actual.toolCommand).be.false();
    should(actual).not.have.property('commandKey');
  });

  it('should key the youngest of two commands, the one being waited on', () => {
    // Arrange
    const processes: readonly PaneProcess[] = [
      { pid: 20, argv: 'zsh -c tsc -w', startedSecondsAgo: 900 },
      { pid: 21, argv: 'zsh -c bun test', startedSecondsAgo: 5 },
    ];

    // Act
    const actual = paneWorkSummary(processes);

    // Assert
    should(actual.commandKey).equal('pid:21');
  });
});
