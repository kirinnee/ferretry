import { describe, it } from 'bun:test';
import should from 'should';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import {
  LARGE_RECORD_BYTES,
  LARGE_STRING_BYTES,
  placeholderRef,
  referenceLargeStrings,
  resolveLargeStrings,
} from '../../../src/lib/transcript/large-strings.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAYLOAD = 'iVBORw0KGgo'.repeat(Math.ceil(LARGE_RECORD_BYTES / 11));

const bytesOf = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

describe('referenceLargeStrings', () => {
  it('should return a small record as it is', () => {
    // Arrange
    const record = bytesOf({ data: 'A'.repeat(100) });

    // Act
    const actual = referenceLargeStrings(record, 0);

    // Assert
    should(actual).equal(record);
  });

  it('should replace a large base64 literal with a placeholder naming its bytes in the file', () => {
    // Arrange
    const record = bytesOf({ type: 'image', source: { data: PAYLOAD, media_type: 'image/png' } });
    const at = 1_000;

    // Act
    const skeleton = referenceLargeStrings(record, at);
    const parsed = JSON.parse(decoder.decode(skeleton)) as { source: { data: string; media_type: string } };
    const ref = placeholderRef(parsed.source.data);

    // Assert — the range holds exactly the payload, and the rest of the record survives.
    should(skeleton.byteLength).be.below(200);
    should(parsed.source.media_type).equal('image/png');
    should(ref?.byteLength).equal(PAYLOAD.length);
    const start = (ref?.byteOffset ?? 0) - at;
    should(decoder.decode(record.subarray(start, start + (ref?.byteLength ?? 0)))).equal(PAYLOAD);
  });

  it('should reference several literals and accept base64url', () => {
    // Arrange
    const url = 'ab-_'.repeat(LARGE_STRING_BYTES / 4);
    const record = bytesOf({ first: PAYLOAD, second: url, small: 'kept' });

    // Act
    const parsed = JSON.parse(decoder.decode(referenceLargeStrings(record, 0))) as Record<string, string>;

    // Assert
    should(placeholderRef(parsed.first)?.byteLength).equal(PAYLOAD.length);
    should(placeholderRef(parsed.second)?.byteLength).equal(url.length);
    should(parsed.small).equal('kept');
  });

  it.each([
    [
      'holds an escape, so its bytes are not its value',
      { text: `${'line\\n'.repeat(LARGE_STRING_BYTES / 6)}"quoted"` },
    ],
    ['is not base64', { text: 'not base64! '.repeat(LARGE_RECORD_BYTES / 12) }],
    ['is too short', { many: Array.from({ length: LARGE_RECORD_BYTES / 100 }, () => 'A'.repeat(100)) }],
  ])('should leave a literal that %s', (_reason, value) => {
    // Arrange
    const record = bytesOf(value);

    // Act
    const actual = referenceLargeStrings(record, 0);

    // Assert
    should(actual).equal(record);
  });

  it('should stop at a literal that never closes', () => {
    // Arrange — a record cut mid-string by a crash.
    const record = encoder.encode(`{"data":"${PAYLOAD}`);

    // Act
    const actual = referenceLargeStrings(record, 0);

    // Assert
    should(actual).equal(record);
  });

  it('should read past escaped quotes and a backslash pair to the literal that follows', () => {
    // Arrange
    const record = encoder.encode(`{"a":"say \\"hi\\" \\\\","data":"${PAYLOAD}","z":"\\\\"}`);

    // Act
    const parsed = JSON.parse(decoder.decode(referenceLargeStrings(record, 0))) as Record<string, string>;

    // Assert
    should(parsed.a).equal('say "hi" \\');
    should(placeholderRef(parsed.data)?.byteLength).equal(PAYLOAD.length);
    should(parsed.z).equal('\\');
  });
});

describe('placeholderRef', () => {
  it.each([
    ['a number', 3],
    ['an ordinary string', 'fy-bytes:1:2'],
    ['nothing', undefined],
  ])('should name no range for %s', (_name, value) => {
    // Act
    const actual = placeholderRef(value);

    // Assert
    should(actual).be.undefined();
  });
});

describe('resolveLargeStrings', () => {
  const placeholder = '\u0000fy-bytes:10:20';

  it('should turn a placeholder data field into a byte range and any other into a note', () => {
    // Arrange
    const value = { attachment: { kind: 'image', data: placeholder }, content: [{ text: placeholder }, 'kept'] };

    // Act
    const actual = resolveLargeStrings(value);

    // Assert
    should(actual).deepEqual({
      attachment: { kind: 'image', dataRef: { byteOffset: 10, byteLength: 20 } },
      content: [{ text: '[base64 data: 20 bytes at byte 10 of the transcript]' }, 'kept'],
    });
  });

  it('should return a value that held no placeholder as the same object', () => {
    // Arrange
    const value = { kind: 'message', parts: [{ text: 'hello' }, 1, null] };

    // Act
    const actual = resolveLargeStrings(value);

    // Assert
    should(actual).equal(value);
  });
});

describe('a Claude transcript with a pasted screenshot', () => {
  it('should reference the screenshot by its bytes and keep the raw record whole', () => {
    // Arrange
    const record = {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-10-29T06:09:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PAYLOAD } },
        ],
      },
    };
    const prefix = encoder.encode(`${JSON.stringify({ type: 'summary', summary: 'start' })}\n`);
    const line = encoder.encode(`${JSON.stringify(record)}\n`);
    const bytes = new Uint8Array(prefix.byteLength + line.byteLength);
    bytes.set(prefix);
    bytes.set(line, prefix.byteLength);
    const parser = new ClaudeTranscriptParser();

    // Act
    const parsed = parser.parse({ bytes, source: 'claude.jsonl', startByteOffset: 500 });
    const attachment = parsed.events.find(
      (event): event is Extract<TranscriptEvent, { kind: 'attachment' }> => event.kind === 'attachment',
    )?.attachment as { readonly data?: string; readonly dataRef?: { byteOffset: number; byteLength: number } };

    // Assert
    should(attachment.data).be.undefined();
    should(attachment.dataRef?.byteLength).equal(PAYLOAD.length);
    const start = (attachment.dataRef?.byteOffset ?? 0) - 500;
    should(decoder.decode(bytes.subarray(start, start + PAYLOAD.length))).equal(PAYLOAD);
    should(parsed.rawRecords?.[1]?.bytes).deepEqual(line);
  });
});
