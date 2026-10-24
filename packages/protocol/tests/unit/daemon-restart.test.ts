import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyDaemonUnreachable,
  DAEMON_RESTART_PATIENCE_MS,
  DAEMON_STARTING_CODE,
  type DaemonAttempt,
  type DaemonRestartPatience,
  DaemonStartingError,
  daemonRestartBackoffMs,
  waitOutDaemonRestart,
} from '../../src/lib/daemon-restart.ts';

const coded = (code: string): Error => Object.assign(new Error(code), { code });
const refused: DaemonAttempt<string> = { kind: 'unreachable', how: 'refused', error: coded('ConnectionRefused') };
const dropped: DaemonAttempt<string> = { kind: 'unreachable', how: 'dropped', error: coded('ECONNRESET') };
const answered = (value: string): DaemonAttempt<string> => ({ kind: 'answered', value });

/** A clock that only moves when the wait sleeps, and a script of what each attempt answers. */
function scripted(outcomes: readonly DaemonAttempt<string>[]) {
  let now = 1_000;
  const sleeps: number[] = [];
  const queue = [...outcomes];
  let attempts = 0;
  return {
    sleeps,
    attempts: () => attempts,
    nowMs: () => now,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    attempt: async () => {
      attempts += 1;
      return queue.shift() ?? refused;
    },
  };
}

function patience(expected: boolean | Promise<boolean>, windowMs?: number) {
  const told: number[] = [];
  const value: DaemonRestartPatience = {
    expected: () => expected,
    waiting: () => told.push(1),
    ...(windowMs === undefined ? {} : { windowMs }),
  };
  return { value, told };
}

describe('classifyDaemonUnreachable', () => {
  it('should read a daemon that answered it is still starting as refused, keeping its words', () => {
    // Act
    const starting = new DaemonStartingError('the daemon is starting (mounting subsystems); ask again shortly');

    // Assert — it ran no route, so it is as safe to send again as a refused connection.
    should(classifyDaemonUnreachable(starting)).equal('refused');
    should(starting.name).equal('DaemonStartingError');
    should(starting.message).containEql('mounting subsystems');
    should(DAEMON_STARTING_CODE).equal('daemon_starting');
  });

  it('should call a refused connection refused, from Bun, Node or a missing socket', () => {
    // Arrange
    const codes = ['ConnectionRefused', 'FailedToOpenSocket', 'ECONNREFUSED', 'ENOENT'];

    // Act
    const actual = codes.map(code => classifyDaemonUnreachable(coded(code)));

    // Assert
    should(actual).deepEqual(['refused', 'refused', 'refused', 'refused']);
  });

  it('should call a connection closed mid-request dropped', () => {
    // Arrange
    const codes = ['ECONNRESET', 'ConnectionClosed', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'];

    // Act
    const actual = codes.map(code => classifyDaemonUnreachable(coded(code)));

    // Assert
    should(actual).deepEqual(['dropped', 'dropped', 'dropped', 'dropped', 'dropped']);
  });

  it('should read the code through a cause chain, as undici nests it', () => {
    // Arrange
    const error = new TypeError('fetch failed', { cause: coded('ECONNREFUSED') });

    // Act
    const actual = classifyDaemonUnreachable(error);

    // Assert
    should(actual).equal('refused');
  });

  it('should not claim anything for an error that does not say why', () => {
    // Arrange
    const errors: unknown[] = [
      new TypeError('Failed to fetch'),
      coded('ETIMEDOUT'),
      Object.assign(new Error('numeric'), { code: 61 }),
      'a string',
      null,
    ];

    // Act
    const actual = errors.map(classifyDaemonUnreachable);

    // Assert
    should(actual).deepEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('daemonRestartBackoffMs', () => {
  it('should double from a quarter second and settle at two seconds', () => {
    // Arrange
    const looks = [-1, 0, 1, 2, 3, 4, 10];

    // Act
    const actual = looks.map(daemonRestartBackoffMs);

    // Assert
    should(actual).deepEqual([250, 250, 500, 1_000, 2_000, 2_000, 2_000]);
    should(DAEMON_RESTART_PATIENCE_MS).equal(60_000);
  });
});

describe('waitOutDaemonRestart', () => {
  it('should wait out a refusing daemon and answer once it serves again, saying so once', async () => {
    // Arrange
    const script = scripted([refused, refused, answered('back')]);
    const { value, told } = patience(true);

    // Act
    const actual = await waitOutDaemonRestart({ ...script, first: refused, repeatable: false, patience: value });

    // Assert
    should(actual).deepEqual(answered('back'));
    should(script.attempts()).equal(3);
    should(script.sleeps).deepEqual([250, 500, 1_000]);
    should(told).have.length(1);
  });

  it('should repeat a dropped request only when the caller says repeating it is harmless', async () => {
    // Arrange
    const repeatable = scripted([answered('applied once')]);
    const notRepeatable = scripted([answered('never asked')]);
    const one = patience(true);
    const other = patience(true);

    // Act
    const yes = await waitOutDaemonRestart({ ...repeatable, first: dropped, repeatable: true, patience: one.value });
    const no = await waitOutDaemonRestart({
      ...notRepeatable,
      first: dropped,
      repeatable: false,
      patience: other.value,
    });

    // Assert
    should(yes).deepEqual(answered('applied once'));
    should(no).equal(dropped);
    should(notRepeatable.attempts()).equal(0);
    should(other.told).have.length(0);
  });

  it('should stop at a dropped answer mid-wait when the request may not be repeated', async () => {
    // Arrange
    const script = scripted([dropped, answered('too late')]);
    const { value } = patience(true);

    // Act
    const actual = await waitOutDaemonRestart({ ...script, first: refused, repeatable: false, patience: value });

    // Assert
    should(actual).equal(dropped);
    should(script.attempts()).equal(1);
  });

  it('should give up when the window closes, never sleeping past it', async () => {
    // Arrange
    const script = scripted([]);
    const { value } = patience(Promise.resolve(true), 1_000);

    // Act
    const actual = await waitOutDaemonRestart({ ...script, first: refused, repeatable: true, patience: value });

    // Assert
    should(actual).equal(refused);
    should(script.sleeps).deepEqual([250, 500, 250]);
    should(script.sleeps.reduce((sum, each) => sum + each, 0)).equal(1_000);
  });

  it('should not wait at all without patience, when a restart is not expected, or for a failure that is not the daemon away', async () => {
    // Arrange
    const none = scripted([]);
    const unexpected = scripted([]);
    const failed = scripted([]);
    const quiet = patience(false);
    const eager = patience(true);
    const other: DaemonAttempt<string> = { kind: 'failed', error: new Error('teapot') };

    // Act
    const withoutPatience = await waitOutDaemonRestart({
      ...none,
      first: refused,
      repeatable: true,
      patience: undefined,
    });
    const notExpected = await waitOutDaemonRestart({
      ...unexpected,
      first: refused,
      repeatable: true,
      patience: quiet.value,
    });
    const notAway = await waitOutDaemonRestart({ ...failed, first: other, repeatable: true, patience: eager.value });

    // Assert
    should(withoutPatience).equal(refused);
    should(notExpected).equal(refused);
    should(notAway).equal(other);
    should(none.attempts() + unexpected.attempts() + failed.attempts()).equal(0);
    should(quiet.told.length + eager.told.length).equal(0);
  });

  it('should end the wait when the caller leaves, before or after a pause', async () => {
    // Arrange
    const before = new AbortController();
    before.abort();
    const early = scripted([]);
    const after = new AbortController();
    const late = scripted([]);
    const lateSleep = async (milliseconds: number) => {
      await late.sleep(milliseconds);
      after.abort();
    };
    const { value } = patience(true);

    // Act
    const left = await waitOutDaemonRestart({
      ...early,
      first: refused,
      repeatable: true,
      patience: value,
      signal: before.signal,
    });
    const leftDuringPause = await waitOutDaemonRestart({
      ...late,
      sleep: lateSleep,
      first: refused,
      repeatable: true,
      patience: value,
      signal: after.signal,
    });

    // Assert
    should(left).equal(refused);
    should(early.sleeps).deepEqual([]);
    should(leftDuringPause).equal(refused);
    should(late.sleeps).deepEqual([250]);
    should(late.attempts()).equal(0);
  });
});
