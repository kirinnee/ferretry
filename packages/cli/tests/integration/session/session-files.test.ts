import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import should from 'should';
import { BunFileSource, SessionFiles } from '../../../src/adapters/session/session-files.ts';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';

// A temp directory of its own: no test may resolve the real state home.
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-session-files-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SessionFiles', () => {
  it('should read a prompt file trimmed of its trailing newline', async () => {
    // Arrange
    const path = join(directory, 'brief.md');
    await writeFile(path, '  the long brief\n\n');
    const subject = new SessionFiles();

    // Act
    const actual = await subject.readText(path);

    // Assert
    should(actual).equal('the long brief');
  });

  it('should report an unreadable text path as the caller mistake it is', async () => {
    // Arrange
    const subject = new SessionFiles();

    // Act
    const failure = await subject.readText(join(directory, 'missing.md')).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(SessionCommandError);
    should((failure as SessionCommandError).message).match(/cannot read .*missing\.md/);
    should((failure as SessionCommandError).exitCode).equal(2);
  });

  it('should base64 an image attachment and state its type', async () => {
    // Arrange
    const path = join(directory, 'shot.png');
    // The 8-byte PNG signature is enough for the runtime to type the file.
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const subject = new SessionFiles();

    // Act
    const actual = await subject.readAttachment(path);

    // Assert
    should(actual.filename).equal('shot.png');
    should(actual.mime).equal('image/png');
    should(actual.base64).equal('iVBORw0KGgo=');
  });

  it('should leave the type off a document, whose extractor decides it', async () => {
    // Arrange
    const path = join(directory, 'notes.txt');
    await writeFile(path, 'hello');
    const subject = new SessionFiles();

    // Act
    const actual = await subject.readAttachment(path);

    // Assert
    should(actual).deepEqual({ filename: 'notes.txt', base64: Buffer.from('hello').toString('base64') });
  });

  it('should refuse an empty attachment rather than uploading nothing', async () => {
    // Arrange
    const path = join(directory, 'empty.png');
    await writeFile(path, '');
    const subject = new SessionFiles();

    // Act
    const failure = await subject.readAttachment(path).catch((error: unknown) => error);

    // Assert
    should((failure as SessionCommandError).message).match(/is empty/);
  });

  it('should report an unreadable attachment path', async () => {
    // Arrange
    const subject = new SessionFiles();

    // Act
    const failure = await subject.readAttachment(join(directory, 'gone.png')).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(SessionCommandError);
    should((failure as SessionCommandError).message).match(/cannot read attachment/);
  });

  it('should read through the Bun file source by default', async () => {
    // Arrange
    const path = join(directory, 'default.txt');
    await writeFile(path, 'through bun');
    const source = new BunFileSource();

    // Act
    const [text, bytes, mime] = await Promise.all([source.text(path), source.bytes(path), source.mime(path)]);

    // Assert
    should(text).equal('through bun');
    should(bytes.byteLength).equal(11);
    should(mime).match(/text\/plain/);
  });
});
