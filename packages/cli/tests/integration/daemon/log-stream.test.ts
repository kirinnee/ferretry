import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { type LogStreamSpawner, TailDaemonLog } from '../../../src/adapters/daemon/log-stream';

describe('tail daemon log', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-log-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should report whether the log exists yet', async () => {
    // Arrange
    const subject = new TailDaemonLog();
    const logFile = join(root, 'fyd.log');

    // Act + Assert
    should(await subject.exists(logFile)).be.false();
    await Bun.write(logFile, 'line\n');
    should(await subject.exists(logFile)).be.true();
  });

  it('should stream an existing log to the terminal and exit zero', async () => {
    // Arrange — the real production spawner, on a log this test wrote.
    const subject = new TailDaemonLog();
    const logFile = join(root, 'fyd.log');
    await Bun.write(logFile, 'first\nsecond\n');

    // Act
    const actual = await subject.show(logFile, false);

    // Assert
    should(actual).equal(0);
  });

  it('should adopt a non-zero exit when the log cannot be read', async () => {
    // Arrange
    const subject = new TailDaemonLog();

    // Act
    const actual = await subject.show(join(root, 'absent.log'), false);

    // Assert — the CLI reports this code rather than pretending the log was empty.
    should(actual).not.equal(0);
  });

  it('should follow by NAME so a rotated or not-yet-created log keeps working', async () => {
    // Arrange — `tail -F` never exits, so the choice of argv is what this asserts.
    const commands: string[][] = [];
    const recording: LogStreamSpawner = argv => {
      commands.push([...argv]);
      return { exited: Promise.resolve(0) };
    };
    const subject = new TailDaemonLog(recording);
    const logFile = join(root, 'fyd.log');

    // Act
    const actual = await subject.show(logFile, true);

    // Assert — kteam used `-f`, which silently keeps reading a rotated-away inode.
    should(commands).deepEqual([['tail', '-F', '-n', '+1', logFile]]);
    should(actual).equal(0);
  });

  it('should read the whole log without following when not asked to', async () => {
    // Arrange
    const commands: string[][] = [];
    const recording: LogStreamSpawner = argv => {
      commands.push([...argv]);
      return { exited: Promise.resolve(0) };
    };
    const subject = new TailDaemonLog(recording);
    const logFile = join(root, 'fyd.log');

    // Act
    await subject.show(logFile, false);

    // Assert
    should(commands).deepEqual([['cat', logFile]]);
  });
});
