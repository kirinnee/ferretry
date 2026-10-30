import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import { type LogStreamSpawner, relayingSpawner, TailDaemonLog } from '../../../src/adapters/daemon/log-stream';

const LOG_STREAM_MODULE = JSON.stringify(resolve(import.meta.dir, '../../../src/adapters/daemon/log-stream.ts'));

/** A log large enough to fill any pipe many times over, each line numbered so order is checkable. */
const bigLog = (): string =>
  `${Array.from({ length: 40_000 }, (_, index) => `${String(index).padStart(6, '0')} ${'x'.repeat(90)}`).join('\n')}\n`;

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

  it('should deliver a whole log to a reader slower than the pipe, as `fy daemon logs | grep` is', async () => {
    // The defect: the child was handed this process's non-blocking stdout, and `cat` died with EAGAIN
    // the moment a slow reader let the pipe fill. A real `fy`-like process, read slowly, proves it now.
    // Arrange
    const logFile = join(root, 'fyd.log');
    const text = bigLog();
    await Bun.write(logFile, text);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { TailDaemonLog } from ${LOG_STREAM_MODULE}; process.exit(await new TailDaemonLog().show(${JSON.stringify(logFile)}, false));`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    // Act — read in small sips with pauses, so the pipe is full most of the time.
    const chunks: Uint8Array[] = [];
    const reader = child.stdout.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      chunks.push(read.value);
      // Pacing, not a wait: a slow consumer is the scenario, and no assertion depends on how long it takes.
      if (chunks.length % 8 === 0) await Bun.sleep(5);
    }
    const code = await child.exited;

    // Assert
    should(await new Response(child.stderr).text()).not.match(/write error|temporarily unavailable/u);
    should(code).equal(0);
    should(Buffer.concat(chunks).toString('utf8')).equal(text);
  });

  it('should relay every byte in order through a sink that takes its time', async () => {
    // Arrange
    const logFile = join(root, 'fyd.log');
    const text = bigLog();
    await Bun.write(logFile, text);
    const received: Uint8Array[] = [];
    const subject = new TailDaemonLog(
      relayingSpawner({
        write: async chunk => {
          received.push(chunk);
          // Pacing for the same slow-consumer scenario; nothing waits on it.
          if (received.length % 16 === 0) await Bun.sleep(1);
        },
      }),
    );

    // Act
    const actual = await subject.show(logFile, false);

    // Assert
    should(actual).equal(0);
    should(Buffer.concat(received).toString('utf8')).equal(text);
  });

  it('should end a followed log quietly when its reader goes away', async () => {
    // Arrange — `tail -F` never exits on its own; a reader that closed (`| head`) must still end it.
    const logFile = join(root, 'fyd.log');
    await Bun.write(logFile, 'first\nsecond\n');
    const subject = new TailDaemonLog(
      relayingSpawner({
        write: async () => {
          throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        },
      }),
    );

    // Act
    const actual = await subject.show(logFile, true);

    // Assert — everything the reader asked for was delivered; that is a normal end.
    should(actual).equal(0);
  });
});
