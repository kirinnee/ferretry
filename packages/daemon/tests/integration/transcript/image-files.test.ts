import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeTranscriptImageFiles } from '../../../src/adapters/transcript/image-files.ts';

const directories: string[] = [];

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-image-files-'));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

describe('NodeTranscriptImageFiles', () => {
  it('should fingerprint a transcript file by its size and modification time', async () => {
    // Arrange
    const file = join(await scratch(), 'one.jsonl');
    await writeFile(file, 'abcdef\n');

    // Act
    const actual = await new NodeTranscriptImageFiles().fingerprint(file);

    // Assert
    should(actual?.size).equal(7);
    should(actual?.mtimeMs).be.above(0);
  });

  it('should give no fingerprint to a file that is missing or is a directory', async () => {
    // Arrange
    const directory = await scratch();
    await mkdir(join(directory, 'folder'));
    const files = new NodeTranscriptImageFiles();

    // Act
    const missing = await files.fingerprint(join(directory, 'nothing.jsonl'));
    const folder = await files.fingerprint(join(directory, 'folder'));

    // Assert
    should(missing).be.undefined();
    should(folder).be.undefined();
  });

  it('should read exactly the byte range it is asked for', async () => {
    // Arrange
    const file = join(await scratch(), 'one.jsonl');
    await writeFile(file, 'line one\nline two\n');

    // Act
    const actual = await new NodeTranscriptImageFiles().readRange(file, 5, 8);

    // Assert
    should(Buffer.from(actual).toString('utf8')).equal('one\nline');
  });
});
