import { describe, it } from 'bun:test';
import should from 'should';
import {
  clearRecordedChrome,
  type OrphanChromeInspector,
  type ProcessIdentity,
  type SignalOutcome,
} from '../../../../daemon/worker/control/adapters/orphan-chrome.ts';

const profile = '/state/browser/profile';
const launched: ProcessIdentity = { startedAt: 'boot:100', args: ['chrome', `--user-data-dir=${profile}`] };
const replacement: ProcessIdentity = { startedAt: 'boot:999', args: ['someone-else'] };
const budget = { termPolls: 2, killPolls: 2 };

/** A process table scripted per `identify` call; every signal is logged, and `onSignal` may change what comes next. */
function scripted(
  identities: (call: number, signals: readonly string[]) => ProcessIdentity | undefined,
  outcome: SignalOutcome = 'delivered',
) {
  const signals: string[] = [];
  let calls = 0;
  const inspector: OrphanChromeInspector = {
    identify: async () => {
      calls += 1;
      return identities(calls, signals);
    },
    signal: (_pid, signal) => {
      signals.push(signal);
      return outcome;
    },
    sleep: async () => undefined,
  };
  return { inspector, signals };
}

describe('clearRecordedChrome', () => {
  it('should stop a Chrome Ferretry recorded when the process is the same one and holds the profile', async () => {
    // Arrange: it exits after SIGTERM.
    const { inspector, signals } = scripted((_call, sent) => (sent.length === 0 ? launched : undefined));

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget);

    // Assert
    should(outcome).equal('cleared');
    should(signals).deepEqual(['SIGTERM']);
  });

  it('should NEVER signal a process on the profile that has no Ferretry launch record (the owner own browser)', async () => {
    // Arrange
    const { inspector, signals } = scripted(() => launched);

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7 }, profile, budget);

    // Assert
    should(outcome).equal('refused');
    should(signals).deepEqual([]);
  });

  it('should NEVER signal when the recorded start time is not the running process start time', async () => {
    // Arrange: the pid was recycled into a browser that also names the profile.
    const { inspector, signals } = scripted(() => ({ ...launched, startedAt: 'boot:555' }));

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget);

    // Assert
    should(outcome).equal('cleared');
    should(signals).deepEqual([]);
  });

  it('should clear a record with no start time, without a signal, when the process is plainly elsewhere', async () => {
    // Arrange
    const { inspector, signals } = scripted(() => replacement);

    // Act + Assert
    should(await clearRecordedChrome(inspector, { pid: 7 }, profile, budget)).equal('cleared');
    should(signals).deepEqual([]);
  });

  it('should refuse and not signal a process whose command line cannot be read', async () => {
    // Arrange
    const unreadable = scripted(() => undefined);
    const noArgs = scripted(() => ({ startedAt: 'boot:100', args: [] }));

    // Act + Assert
    should(await clearRecordedChrome(unreadable.inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget)).equal(
      'refused',
    );
    should(await clearRecordedChrome(noArgs.inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget)).equal(
      'refused',
    );
    should([...unreadable.signals, ...noArgs.signals]).deepEqual([]);
  });

  it('should NEVER SIGKILL a replacement process that took the pid after SIGTERM', async () => {
    // Arrange: TERM lands, the Chrome exits, and an unrelated process is given its pid.
    const { inspector, signals } = scripted((_call, sent) => (sent.length === 0 ? launched : replacement));

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget);

    // Assert
    should(outcome).equal('cleared');
    should(signals).deepEqual(['SIGTERM']);
  });

  it('should re-check the identity immediately before SIGKILL, not trust the check made before SIGTERM', async () => {
    // Arrange: the Chrome ignores TERM through every poll, then is replaced exactly between the last poll and the
    // re-check before KILL (calls: 1 first look, 2 before TERM, 3-4 polls, 5 before KILL).
    const { inspector, signals } = scripted(call => (call < 5 ? launched : replacement));

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget);

    // Assert
    should(outcome).equal('cleared');
    should(signals).deepEqual(['SIGTERM']);
  });

  it('should SIGKILL only the very process that ignored SIGTERM, and report refused if it survives', async () => {
    // Arrange
    const { inspector, signals } = scripted(() => launched);

    // Act
    const outcome = await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget);

    // Assert
    should(outcome).equal('refused');
    should(signals).deepEqual(['SIGTERM', 'SIGKILL']);
  });

  it('should refuse when the signal is denied', async () => {
    // Arrange
    const { inspector } = scripted(() => launched, 'denied');

    // Act + Assert
    should(await clearRecordedChrome(inspector, { pid: 7, startedAt: 'boot:100' }, profile, budget)).equal('refused');
  });
});
