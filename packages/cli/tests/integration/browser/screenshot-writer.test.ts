import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileScreenshotWriter } from '../../../src/adapters/browser/screenshot-writer';

// A one-pixel PNG, so the round trip is checked against real image bytes rather than a token string.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('writing an explicit screenshot', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy-screenshot-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('should decode the base64 into the exact bytes the daemon captured', async () => {
    // Arrange
    const target = join(directory, 'shot.png');

    // Act
    await new FileScreenshotWriter().write(target, PNG_BASE64);

    // Assert
    const written = await readFile(target);
    should(written.equals(Buffer.from(PNG_BASE64, 'base64'))).be.true();
    should(written.subarray(1, 4).toString('latin1')).equal('PNG');
  });

  it('should create the directories the operator named', async () => {
    // Arrange
    const target = join(directory, 'nested', 'deeper', 'shot.png');

    // Act
    await new FileScreenshotWriter().write(target, PNG_BASE64);

    // Assert
    should((await readFile(target)).byteLength).be.greaterThan(0);
  });

  it('should overwrite an existing file rather than append to it', async () => {
    // Arrange
    const target = join(directory, 'shot.png');
    const writer = new FileScreenshotWriter();
    await writer.write(target, 'aGVsbG8gdGhlcmU=');

    // Act
    await writer.write(target, PNG_BASE64);

    // Assert
    should((await readFile(target)).equals(Buffer.from(PNG_BASE64, 'base64'))).be.true();
  });

  it('should refuse malformed base64 instead of writing a corrupt file', async () => {
    // Arrange
    const target = join(directory, 'shot.png');
    const writer = new FileScreenshotWriter();

    // Act + Assert
    for (const payload of ['', 'not base64!', 'aGk', '====']) {
      await should(writer.write(target, payload)).be.rejectedWith(/malformed screenshot bytes/u);
    }
    await should(readFile(target)).be.rejected();
  });

  it('should report a path it cannot write', async () => {
    // Arrange — a file stands where a directory would have to be.
    const blocker = join(directory, 'blocker');
    const writer = new FileScreenshotWriter();
    await writer.write(blocker, PNG_BASE64);

    // Act + Assert
    await should(writer.write(join(blocker, 'shot.png'), PNG_BASE64)).be.rejected();
  });
});
