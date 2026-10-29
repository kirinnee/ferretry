import { describe, it } from 'bun:test';
import should from 'should';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { eventImages, markerMediaType, numberRecordImages, recordImages } from '../../../src/lib/transcript/images.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import {
  claudeText,
  claudeToolResultImage,
  claudeUserImage,
  codexGeneratedImage,
  codexInputImage,
  MemoryTranscript,
  pngBase64,
} from '../../support/transcript-images.ts';

type ImageAttachment = Omit<
  Extract<Extract<TranscriptEvent, { kind: 'attachment' }>['attachment'], { kind: 'image' }>,
  'kind'
>;

const attachment = (
  fields: Partial<ImageAttachment>,
  at: { byteOffset?: number; byteLength?: number } = { byteOffset: 10, byteLength: 50 },
): TranscriptEvent => ({
  kind: 'attachment',
  harness: 'claude',
  role: 'user',
  attachment: { kind: 'image', ...fields },
  ...at,
});

const toolResult = (
  content: unknown,
  at: { byteOffset?: number; byteLength?: number } = { byteOffset: 10, byteLength: 50 },
): TranscriptEvent =>
  ({
    kind: 'tool-result',
    harness: 'claude',
    role: 'tool',
    result: { callId: 'c1', content, isError: false },
    ...at,
  }) as TranscriptEvent;

describe('eventImages', () => {
  it('should find an image attachment held inline', () => {
    // Act
    const actual = eventImages(attachment({ data: 'AAAA', mediaType: 'image/png', name: 'a.png' }));

    // Assert
    should(actual).eql([{ mediaType: 'image/png', alt: 'a.png', data: 'AAAA' }]);
  });

  it('should find an image attachment whose bytes were left in the file', () => {
    // Act
    const actual = eventImages(attachment({ dataRef: { byteOffset: 100, byteLength: 40_000 } }));

    // Assert
    should(actual).eql([{ dataRef: { byteOffset: 100, byteLength: 40_000 } }]);
  });

  it('should find an image attachment that is a base64 data URL and name its declared type', () => {
    // Act
    const actual = eventImages(attachment({ uri: 'data:image/jpeg;base64,/9j/4AAQ' }));

    // Assert
    should(actual).eql([{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }]);
  });

  it('should find a data URL that names no type', () => {
    // Act
    const actual = eventImages(attachment({ uri: 'data:;base64,AAAA' }));

    // Assert
    should(actual).eql([{ data: 'AAAA' }]);
  });

  it.each([
    ['a link to the web', { uri: 'https://example.com/a.png' }],
    ['a data URL that is not base64', { uri: 'data:image/svg+xml,%3Csvg%3E' }],
    ['a data URL with no payload', { uri: 'data:image/png;base64, ' }],
    ['a malformed data URL', { uri: 'data:image/png' }],
    ['a name only', { name: 'a.png' }],
    ['an unusable byte range', { dataRef: { byteOffset: -1, byteLength: 4 } }],
    ['a blank body', { data: '   ' }],
  ])('should hold no image for %s', (_name, fields) => {
    // Act
    const actual = eventImages(attachment(fields));

    // Assert
    should(actual).eql([]);
  });

  it('should ignore an attachment that is not an image', () => {
    // Act
    const actual = eventImages({ ...attachment({}), attachment: { kind: 'file', data: 'AAAA' } } as TranscriptEvent);

    // Assert
    should(actual).eql([]);
  });

  it('should find image blocks in a tool result, through wrappers and in order', () => {
    // Arrange
    const content = [
      { type: 'text', text: 'shot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, name: 'one.png' },
      {
        content: [
          { type: 'image', source: { dataRef: { byteOffset: 5, byteLength: 40_000 }, mediaType: 'image/webp' } },
        ],
      },
      { type: 'output_image', image_url: 'data:image/png;base64,BBBB' },
      { type: 'image', data: 'CCCC', mime_type: 'image/png' },
      { type: 'image', url: 'https://example.com/x.png' },
    ];

    // Act
    const actual = eventImages(toolResult(content));

    // Assert
    should(actual).eql([
      { mediaType: 'image/png', alt: 'one.png', data: 'AAAA' },
      { mediaType: 'image/webp', dataRef: { byteOffset: 5, byteLength: 40_000 } },
      { mediaType: 'image/png', data: 'BBBB' },
      { mediaType: 'image/png', data: 'CCCC' },
    ]);
  });

  it('should look through an MCP result wrapper to a data URL image', () => {
    // Arrange
    const content = { Ok: { content: [{ type: 'input_image', image_url: { url: 'data:image/gif;base64,R0lG' } }] } };

    // Act
    const actual = eventImages(toolResult(content));

    // Assert
    should(actual).eql([{ mediaType: 'image/gif', data: 'R0lG' }]);
  });

  it('should not look deeper than a result really nests', () => {
    // Arrange
    const deep = { content: { content: { content: { content: [{ type: 'image', data: 'AAAA' }] } } } };

    // Act
    const actual = eventImages(toolResult(deep));

    // Assert
    should(actual).eql([]);
  });

  it('should hold no image for text, a string result or any other event', () => {
    // Act / Assert
    should(eventImages(toolResult('plain text'))).eql([]);
    should(eventImages(toolResult(null))).eql([]);
    should(eventImages({ kind: 'message', harness: 'claude', role: 'user', text: 'hi' } as TranscriptEvent)).eql([]);
  });
});

describe('numberRecordImages', () => {
  it('should number images per record, across the events of one record', () => {
    // Arrange
    const events = [
      attachment({ data: 'AAAA' }, { byteOffset: 0, byteLength: 40 }),
      attachment({ data: 'BBBB' }, { byteOffset: 0, byteLength: 40 }),
      attachment({ data: 'CCCC' }, { byteOffset: 41, byteLength: 40 }),
    ];

    // Act
    const actual = numberRecordImages(events).map(each => each.map(image => image.handle));

    // Assert
    should(actual).eql([
      [{ recordOffset: 0, recordLength: 40, ordinal: 0 }],
      [{ recordOffset: 0, recordLength: 40, ordinal: 1 }],
      [{ recordOffset: 41, recordLength: 40, ordinal: 0 }],
    ]);
  });

  it('should name nothing for an event with no record metadata', () => {
    // Act
    const actual = numberRecordImages([attachment({ data: 'AAAA' }, {})]);

    // Assert
    should(actual).eql([[]]);
  });

  it.each([
    ['a zero length', { byteOffset: 0, byteLength: 0 }],
    ['a fractional offset', { byteOffset: 0.5, byteLength: 4 }],
    ['a negative offset', { byteOffset: -1, byteLength: 4 }],
    ['a record past the protocol bound', { byteOffset: 0, byteLength: 33 * 1024 * 1024 }],
    ['an offset no integer can add to', { byteOffset: Number.MAX_SAFE_INTEGER, byteLength: 4 }],
  ])('should name nothing for %s', (_name, at) => {
    // Act
    const actual = numberRecordImages([attachment({ data: 'AAAA' }, at)]);

    // Assert
    should(actual).eql([[]]);
  });

  it('should stop naming at the protocol ordinal ceiling', () => {
    // Arrange
    const events = Array.from({ length: 258 }, () => attachment({ data: 'AAAA' }));

    // Act
    const actual = recordImages(events);

    // Assert
    should(actual).have.length(256);
    should(actual.at(-1)?.handle.ordinal).equal(255);
  });

  it('should leave the first record unnamed when a window may have cut it', () => {
    // Arrange
    const events = [
      attachment({ data: 'AAAA' }, { byteOffset: 0, byteLength: 40 }),
      attachment({ data: 'BBBB' }, { byteOffset: 41, byteLength: 40 }),
    ];

    // Act
    const actual = numberRecordImages(events, { partialFirstRecord: true }).map(each => each.length);

    // Assert
    should(actual).eql([0, 1]);
  });

  it('should name everything when the window is whole', () => {
    // Act
    const actual = numberRecordImages([attachment({ data: 'AAAA' })], { partialFirstRecord: true });
    const empty = numberRecordImages([], { partialFirstRecord: true });

    // Assert
    should(actual[0]).have.length(0);
    should(empty).eql([]);
    should(recordImages([attachment({ data: 'AAAA' })])).have.length(1);
  });
});

describe('markerMediaType', () => {
  it.each([
    ['image/png', 'image/png'],
    ['IMAGE/JPEG', 'image/jpeg'],
    ['text/html', undefined],
    [undefined, undefined],
  ])('should read %s as %s', (declared, expected) => {
    // Act
    const actual = markerMediaType({ mediaType: declared });

    // Assert
    should(actual).equal(expected);
  });
});

describe('the images of parsed transcripts', () => {
  const big = pngBase64(100_000);

  it('should number a Claude transcript the way the route will, including a record large enough to be referenced', () => {
    // Arrange
    const transcript = new MemoryTranscript([
      claudeText(1),
      claudeUserImage(2, [pngBase64(), pngBase64(40)]),
      claudeToolResultImage(3, [big]),
      claudeUserImage(4, [big]),
    ]);

    // Act
    const parsed = new ClaudeTranscriptParser().parse({ bytes: transcript.bytes, endOfInput: true });
    const actual = recordImages(parsed.events);

    // Assert
    should(actual.map(image => image.handle)).eql([
      { recordOffset: transcript.offsets[1], recordLength: transcript.lengths[1], ordinal: 0 },
      { recordOffset: transcript.offsets[1], recordLength: transcript.lengths[1], ordinal: 1 },
      { recordOffset: transcript.offsets[2], recordLength: transcript.lengths[2], ordinal: 0 },
      { recordOffset: transcript.offsets[3], recordLength: transcript.lengths[3], ordinal: 0 },
    ]);
    should(actual.map(image => image.data !== undefined)).eql([true, true, false, false]);
    should(actual[2]?.dataRef?.byteLength).equal(big.length);
    should(actual[3]?.dataRef?.byteLength).equal(big.length);
  });

  it('should find a Codex data URL image, a referenced generated image and a small generated image', () => {
    // Arrange
    const transcript = new MemoryTranscript(
      [
        codexInputImage(1, `data:image/png;base64,${pngBase64()}`),
        codexGeneratedImage(2, big),
        codexGeneratedImage(3, pngBase64()),
      ],
      'codex',
    );

    // Act
    const parsed = new CodexTranscriptParser().parse({ bytes: transcript.bytes, endOfInput: true });
    const actual = recordImages(parsed.events);

    // Assert
    should(actual.map(image => [image.handle.recordOffset, image.data !== undefined, image.dataRef !== undefined])).eql(
      [
        [transcript.offsets[0], true, false],
        [transcript.offsets[1], false, true],
        [transcript.offsets[2], true, false],
      ],
    );
  });
});
