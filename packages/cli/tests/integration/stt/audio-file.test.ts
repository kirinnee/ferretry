import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunAudioFileReader } from '../../../src/adapters/stt/audio-file';

describe('reading an audio clip off disk', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy-stt-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('should return the exact bytes on disk, including the ones a text reader would mangle', async () => {
    // Arrange — bytes chosen because they are not valid UTF-8
    const target = join(directory, 'clip.pcm');
    const samples = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xc0, 0x01]);
    await writeFile(target, samples);

    // Act
    const actual = await new BunAudioFileReader().read(target);

    // Assert
    should([...actual]).eql([...samples]);
  });

  it('should read an empty file as zero bytes rather than failing', async () => {
    // Arrange — the emptiness check belongs to the domain, not the reader
    const target = join(directory, 'empty.pcm');
    await writeFile(target, new Uint8Array(0));

    // Act
    const actual = await new BunAudioFileReader().read(target);

    // Assert
    should(actual.byteLength).equal(0);
  });

  it('should name the path that does not exist', async () => {
    // Arrange
    const missing = join(directory, 'nope.wav');

    // Act + Assert
    await should(new BunAudioFileReader().read(missing)).be.rejectedWith(`no audio file at "${missing}"`);
  });

  it('should name a directory given where a file was expected', async () => {
    // Act + Assert
    await should(new BunAudioFileReader().read(directory)).be.rejected();
  });

  it('should report an unreadable file with its path rather than a bare syscall error', async () => {
    // Arrange
    const target = join(directory, 'locked.wav');
    await writeFile(target, new Uint8Array([1, 2, 3]));
    await chmod(target, 0o000);

    // Act + Assert
    await should(new BunAudioFileReader().read(target)).be.rejectedWith(new RegExp(`cannot read "${target}"`, 'u'));

    // Cleanup — restore the mode so the temp directory can be removed
    await chmod(target, 0o600);
  });
});
