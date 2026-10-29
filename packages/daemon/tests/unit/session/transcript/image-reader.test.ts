import { describe, it } from 'bun:test';
import should from 'should';
import {
  TranscriptImageError,
  type TranscriptImageFailure,
} from '../../../../src/lib/session/transcript/image-reader.ts';
import {
  claudeText,
  claudeToolResultImage,
  claudeUserImage,
  codexGeneratedImage,
  codexInputImage,
  jpegBase64,
  MemoryTranscript,
  pngBase64,
} from '../../../support/transcript-images.ts';

const refusal = async (promise: Promise<unknown>): Promise<TranscriptImageFailure | 'accepted'> =>
  await promise.then(
    () => 'accepted' as const,
    (error: unknown) =>
      error instanceof TranscriptImageError
        ? error.failure
        : (() => {
            throw error;
          })(),
  );

const BIG = pngBase64(100_000);

describe('TranscriptImageReader', () => {
  it('should serve the image a handle names, with its real type and size', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeText(1), claudeUserImage(2, [pngBase64(), jpegBase64()])]);

    // Act
    const first = await transcript.reader().lookup('s1', transcript.handle(1, 0));
    const second = await transcript.reader().lookup('s1', transcript.handle(1, 1));

    // Assert
    should(first.image).eql({ handle: transcript.handle(1, 0), mediaType: 'image/png', byteLength: 32 });
    should((await first.download()).base64).equal(pngBase64());
    should(second.image.mediaType).equal('image/jpeg');
    should((await second.download()).base64).equal(jpegBase64());
  });

  describe('lookupAt', () => {
    it('should prove an image of a transcript the caller already located, asking no locator', async () => {
      // Arrange: a transcript the locator knows nothing of
      const transcript = new MemoryTranscript([claudeText(1), claudeUserImage(2, [pngBase64()])], 'claude', false);
      const target = { file: '/transcripts/one.jsonl', harness: 'claude' } as const;

      // Act
      const found = await transcript.reader().lookupAt('s1', transcript.handle(1), target);

      // Assert
      should(found.image).eql({ handle: transcript.handle(1), mediaType: 'image/png', byteLength: 32 });
      should((await found.download()).base64).equal(pngBase64());
      should(await refusal(transcript.reader().lookup('s1', transcript.handle(1)))).equal('no_transcript');
    });

    it('should refuse a handle that does not parse, even for a located transcript', async () => {
      // Arrange
      const transcript = new MemoryTranscript([claudeText(1)]);

      // Act
      const actual = await refusal(
        transcript.reader().lookupAt('s1', 'nonsense', { file: '/transcripts/one.jsonl', harness: 'claude' }),
      );

      // Assert
      should(actual).equal('invalid_image_handle');
    });
  });

  it('should serve an image a tool result held, and one big enough that its bytes stayed in the file', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeToolResultImage(1, [BIG]), claudeUserImage(2, [BIG])]);
    const reader = transcript.reader();

    // Act
    const fromResult = await reader.lookup('s1', transcript.handle(0));
    const fromUser = await reader.lookup('s1', transcript.handle(1));

    // Assert
    should(fromResult.image.byteLength).equal(100_008);
    should((await fromResult.download()).base64).equal(BIG);
    should((await fromUser.download()).base64).equal(BIG);
  });

  it('should serve Codex images: a data URL, a referenced generated image and a small one', async () => {
    // Arrange
    const transcript = new MemoryTranscript(
      [
        codexInputImage(1, `data:image/png;base64,${pngBase64()}`),
        codexGeneratedImage(2, BIG),
        codexGeneratedImage(3, pngBase64()),
      ],
      'codex',
    );
    const reader = transcript.reader();

    // Act
    const downloads = await Promise.all(
      [0, 1, 2].map(async line => await (await reader.lookup('s1', transcript.handle(line))).download()),
    );

    // Assert
    should(downloads.map(each => each.base64)).eql([pngBase64(), BIG, pngBase64()]);
  });

  it('should read a transcript whose last record has no newline yet as unavailable, not as an image', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [pngBase64()])], 'claude', true, false);

    // Act
    const actual = await refusal(transcript.reader().lookup('s1', transcript.handle(0)));

    // Assert
    should(actual).equal('image_not_found');
  });

  it('should remember a proof: the second ask reads no record and a referenced image reads only its bytes', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [BIG])]);
    const reader = transcript.reader();
    await reader.lookup('s1', transcript.handle(0));
    const afterProof = transcript.reads;

    // Act
    const again = await reader.lookup('s1', transcript.handle(0));
    const afterAsk = transcript.reads;
    await again.download();

    // Assert
    should(afterAsk).equal(afterProof);
    should(transcript.reads).equal(afterProof + 1);
  });

  it('should give the same strong validator for the same image and a different one for another', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [pngBase64(), pngBase64()])]);
    const reader = transcript.reader();

    // Act
    const one = await reader.lookup('s1', transcript.handle(0, 0));
    const same = await reader.lookup('s1', transcript.handle(0, 0));
    const other = await reader.lookup('s1', transcript.handle(0, 1));

    // Assert
    should(one.etag).equal(same.etag);
    should(one.etag).not.equal(other.etag);
    should(one.etag).match(/^"[A-Za-z0-9_-]+"$/u);
  });

  it('should prove again, never trusting an old proof, when the file has changed', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [pngBase64()])]);
    const reader = transcript.reader();
    const handle = transcript.handle(0);
    await reader.lookup('s1', handle);
    const before = transcript.reads;
    transcript.mtimeMs += 1;

    // Act
    await reader.lookup('s1', handle);

    // Assert
    should(transcript.reads).be.above(before);
  });

  it('should refuse a referenced image whose bytes changed after it was proved', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [BIG])]);
    const reader = transcript.reader();
    const lookup = await reader.lookup('s1', transcript.handle(0));
    transcript.bytes = Buffer.from(
      transcript.bytes.toString('latin1').replaceAll('iVBORw0KGgo', 'AAAAAAAAAAA'),
      'latin1',
    );

    // Act
    const actual = await refusal(lookup.download());

    // Assert
    should(actual).equal('image_not_found');
  });

  it('should not hold an unbounded number of proofs', async () => {
    // Arrange
    const transcript = new MemoryTranscript([claudeUserImage(1, [pngBase64(), pngBase64(), pngBase64()])]);
    const reader = transcript.reader(2);
    for (const ordinal of [0, 1, 2]) await reader.lookup('s1', transcript.handle(0, ordinal));
    const before = transcript.reads;

    // Act
    await reader.lookup('s1', transcript.handle(0, 2));
    const newest = transcript.reads;
    await reader.lookup('s1', transcript.handle(0, 0));

    // Assert
    should(newest).equal(before);
    should(transcript.reads).be.above(newest);
  });

  it('should serve, without remembering, an inline image too large to be worth holding', async () => {
    // Arrange
    const huge = pngBase64(200_000);
    const transcript = new MemoryTranscript([claudeUserImage(1, [huge])], 'claude');
    // Under the large-record threshold the parser holds it inline; over it, it is referenced.
    const reader = transcript.reader();

    // Act
    const lookup = await reader.lookup('s1', transcript.handle(0));

    // Assert
    should((await lookup.download()).base64).equal(huge);
  });

  describe('refusals', () => {
    const transcript = new MemoryTranscript([claudeText(1), claudeUserImage(2, [pngBase64()]), claudeText(3)]);
    const line = 1;
    const offset = transcript.offsets[line] as number;
    const length = transcript.lengths[line] as number;

    it.each([
      ['not a handle at all', 'nonsense'],
      ['a negative offset', `-1.${String(length)}.0`],
      ['a zero length', `${String(offset)}.0.0`],
      ['an ordinal above the ceiling', `${String(offset)}.${String(length)}.256`],
      ['a leading zero', `0${String(offset)}.${String(length)}.0`],
      ['a path', '../../etc/passwd'],
    ])('should refuse %s as an invalid handle', async (_name, handle) => {
      // Act
      const actual = await refusal(transcript.reader().lookup('s1', handle));

      // Assert
      should(actual).equal('invalid_image_handle');
    });

    it.each([
      ['an offset in the middle of a record', `${String(offset + 5)}.${String(length)}.0`],
      ['an offset one before the record, on the newline', `${String(offset - 1)}.${String(length)}.0`],
      ['a length one short', `${String(offset)}.${String(length - 1)}.0`],
      ['a length one long', `${String(offset)}.${String(length + 1)}.0`],
      [
        'a length covering two records',
        `${String(offset)}.${String(length + (transcript.lengths[2] as number) + 1)}.0`,
      ],
      ["an ordinal past the record's last image", `${String(offset)}.${String(length)}.1`],
      ['a record with no images', `${String(transcript.offsets[0])}.${String(transcript.lengths[0])}.0`],
      ['a range past the end of the file', `${String(transcript.bytes.byteLength)}.10.0`],
      ['a range that begins past the end of the file', `${String(transcript.bytes.byteLength + 1000)}.10.0`],
    ])('should refuse %s as no such image', async (_name, handle) => {
      // Act
      const actual = await refusal(transcript.reader().lookup('s1', handle));

      // Assert
      should(actual).equal('image_not_found');
    });

    it('should refuse an image whose bytes are not an image, whatever the transcript calls them', async () => {
      // Arrange
      const html = Buffer.from('<html><body>not an image, merely labelled one</body></html>').toString('base64');
      const forged = new MemoryTranscript([claudeUserImage(1, [html], 'image/png')]);

      // Act
      const actual = await refusal(forged.reader().lookup('s1', forged.handle(0)));

      // Assert
      should(actual).equal('unsupported_image');
    });

    const forgedLine = (second: string): string => claudeUserImage(2, [BIG, second]);

    it('should refuse a forged placeholder that points outside its own record', async () => {
      // Arrange: a record large enough to be referenced, carrying a second "image" that forges a placeholder
      const forged = new MemoryTranscript([claudeText(1), forgedLine('\u0000fy-bytes:0:40')]);

      // Act
      const genuine = await forged.reader().lookup('s1', forged.handle(1, 0));
      const actual = await refusal(forged.reader().lookup('s1', forged.handle(1, 1)));

      // Assert
      should(genuine.image.mediaType).equal('image/png');
      should(actual).equal('image_not_found');
    });

    it('should refuse a forged placeholder that points inside its record at something that is not an image', async () => {
      // Arrange
      const probe = new MemoryTranscript([forgedLine('\u0000fy-bytes:1:40')]);
      const index = probe.bytes.toString('latin1').indexOf('"type":"user"');
      const forged = new MemoryTranscript([forgedLine(`\u0000fy-bytes:${String(index)}:40`)]);

      // Act
      const actual = await refusal(forged.reader().lookup('s1', forged.handle(0, 1)));

      // Assert
      should(actual).equal('unsupported_image');
    });

    it('should refuse a session with no transcript', async () => {
      // Arrange
      const missing = new MemoryTranscript([claudeUserImage(1, [pngBase64()])], 'claude', false);

      // Act
      const actual = await refusal(missing.reader().lookup('nobody', missing.handle(0)));

      // Assert
      should(actual).equal('no_transcript');
    });

    it('should refuse a transcript that cannot be statted or read, without naming a path', async () => {
      // Arrange
      const stat = new MemoryTranscript([claudeUserImage(1, [pngBase64()])]);
      stat.fingerprint = async () => await Promise.reject(new Error('EACCES /home/someone/.claude/x.jsonl'));
      const read = new MemoryTranscript([claudeUserImage(1, [pngBase64()])]);
      read.readRange = async () => await Promise.reject(new Error('EIO /home/someone/.claude/x.jsonl'));
      const gone = new MemoryTranscript([claudeUserImage(1, [pngBase64()])]);
      gone.fingerprint = async () => await Promise.reject(new Error('gone'));

      // Act
      const failures = await Promise.all(
        [stat, read, gone].map(
          async each =>
            await each
              .reader()
              .lookup('s1', each.handle(0))
              .then(
                () => undefined,
                (error: unknown) => error as TranscriptImageError,
              ),
        ),
      );

      // Assert
      should(failures.map(error => error?.failure)).eql([
        'transcript_unreadable',
        'transcript_unreadable',
        'transcript_unreadable',
      ]);
      for (const error of failures) should(error?.message).not.match(/\/home|\.jsonl|EACCES|EIO/u);
    });

    it('should never put the transcript path in a refusal', async () => {
      // Act
      const error = await transcript
        .reader()
        .lookup('s1', `${String(offset + 5)}.${String(length)}.0`)
        .then(
          () => undefined,
          (caught: unknown) => caught as TranscriptImageError,
        );

      // Assert
      should(error?.message).not.match(/transcripts|\.jsonl/u);
    });
  });

  it('should bound how many records are proved at once', async () => {
    // Arrange
    const transcript = new MemoryTranscript(
      Array.from({ length: 6 }, (_, index) => claudeUserImage(index, [pngBase64()])),
    );
    let active = 0;
    let peak = 0;
    const read = transcript.readRange.bind(transcript);
    transcript.readRange = async (file, byteOffset, byteLength) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      const bytes = await read(file, byteOffset, byteLength);
      active -= 1;
      return bytes;
    };
    const reader = transcript.reader();

    // Act
    await Promise.all([0, 1, 2, 3, 4, 5].map(async line => await reader.lookup('s1', transcript.handle(line))));

    // Assert
    should(peak).be.belowOrEqual(2);
  });
});
