import {
  type TranscriptImageFiles,
  type TranscriptImageLocator,
  TranscriptImageReader,
} from '../../src/lib/session/transcript/image-reader.ts';
import { ClaudeTranscriptParser } from '../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../src/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../../src/lib/transcript/sliced.ts';

const NO_WAIT = { now: () => 0, yieldToLoop: async (): Promise<void> => undefined };

/** The first bytes of a PNG, then `size` bytes of filler: sniffs as a PNG, which is all a route may ask. */
export const pngBytes = (size: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 0x2f)]);

/** Standard padded base64 of a PNG of `size` filler bytes. */
export const pngBase64 = (size = 24): string => pngBytes(size).toString('base64');

export const jpegBase64 = (size = 24): string =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 0x41)]).toString('base64');

export const gifBase64 = (): string =>
  Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1').toString('base64');

export const webpBase64 = (): string =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(24),
  ]).toString('base64');

const stamp = (index: number): string => new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();

/** One Claude user record: some text and image blocks. */
export const claudeUserImage = (index: number, images: readonly string[], mediaType = 'image/png'): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${String(index)}`,
    timestamp: stamp(index),
    sessionId: 's1',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: `look at this ${String(index)}` },
        ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
      ],
    },
  });

/** One Claude user record carrying a tool result whose content holds text and image blocks. */
export const claudeToolResultImage = (index: number, images: readonly string[]): string =>
  JSON.stringify({
    type: 'user',
    uuid: `r-${String(index)}`,
    timestamp: stamp(index),
    sessionId: 's1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${String(index)}`,
          content: [
            { type: 'text', text: 'screenshot taken' },
            ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
          ],
        },
      ],
    },
  });

export const claudeText = (index: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a-${String(index)}`,
    timestamp: stamp(index),
    sessionId: 's1',
    message: {
      id: `m-${String(index)}`,
      role: 'assistant',
      content: [{ type: 'text', text: `reply ${String(index)}` }],
    },
  });

/** A Codex user message holding an `input_image` whose URL is a data URL. */
export const codexInputImage = (index: number, dataUrl: string): string =>
  JSON.stringify({
    timestamp: stamp(index),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'see this' },
        { type: 'input_image', image_url: dataUrl },
      ],
    },
  });

/** A Codex generated image: a tool call and then the image itself, in the same record. */
export const codexGeneratedImage = (index: number, base64: string): string =>
  JSON.stringify({
    timestamp: stamp(index),
    type: 'response_item',
    payload: { type: 'image_generation_call', id: `ig-${String(index)}`, revised_prompt: 'a diagram', result: base64 },
  });

/** A transcript held in memory: its lines, where each begins, and a file that can be rewritten. */
export class MemoryTranscript implements TranscriptImageFiles, TranscriptImageLocator {
  bytes: Buffer;
  mtimeMs = 1_000;
  reads = 0;
  readonly offsets: number[] = [];
  readonly lengths: number[] = [];

  constructor(
    lines: readonly string[],
    private readonly harness: 'claude' | 'codex' = 'claude',
    private readonly present = true,
    terminate = true,
  ) {
    const parts: Buffer[] = [];
    let at = 0;
    lines.forEach((line, index) => {
      const body = Buffer.from(line);
      this.offsets.push(at);
      this.lengths.push(body.byteLength);
      const last = index === lines.length - 1;
      const piece = last && !terminate ? body : Buffer.concat([body, Buffer.from('\n')]);
      parts.push(piece);
      at += piece.byteLength;
    });
    this.bytes = Buffer.concat(parts);
  }

  /** The handle text of image `ordinal` in line `line`. */
  handle(line: number, ordinal = 0): string {
    return `${String(this.offsets[line])}.${String(this.lengths[line])}.${String(ordinal)}`;
  }

  async locate(): Promise<{ file: string; harness: 'claude' | 'codex' } | undefined> {
    return this.present ? { file: '/transcripts/one.jsonl', harness: this.harness } : undefined;
  }

  async fingerprint(): Promise<{ size: number; mtimeMs: number }> {
    return { size: this.bytes.byteLength, mtimeMs: this.mtimeMs };
  }

  async readRange(_file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    this.reads += 1;
    return this.bytes.subarray(byteOffset, byteOffset + byteLength);
  }

  reader(capacity?: number): TranscriptImageReader {
    return new TranscriptImageReader(
      this,
      this,
      {
        claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), NO_WAIT),
        codex: new PacedTranscriptParser(new CodexTranscriptParser(), NO_WAIT),
      },
      capacity,
    );
  }
}
