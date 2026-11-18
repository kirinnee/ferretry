/** The incremental tail read answers exactly what one parse of the window answers, for growth, cuts and replacement. */
import { describe, expect, test } from 'bun:test';
import { markCutWindow, parseTail } from '../../../daemon/lib/harness/transcript.ts';
import {
  advanceCursor,
  advanceFrom,
  canAdvance,
  openCursor,
  type TailCursor,
  windowRecords,
} from '../../../daemon/lib/harness/transcript-cursor.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const record = (n: number): string => {
  switch (n % 5) {
    case 0:
      return JSON.stringify({
        type: 'user',
        timestamp: '2026-11-08T10:00:00.000Z',
        message: { content: `héllo ✓ ${n}` },
      });
    case 1:
      return JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-08T10:00:01.000Z',
        message: {
          id: `m${n}`,
          content: [{ type: 'tool_use', name: 'Bash' }],
          usage: { input_tokens: n, output_tokens: 2 },
        },
      });
    case 2:
      return JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x'.repeat(n % 40) }] },
      });
    case 3:
      return 'not json at all ✗';
    default:
      return JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-08T10:00:02.000Z',
        message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      });
  }
};

/** What today's reader answers for a file's bytes: the last `windowBytes`, parsed whole. */
function reference(file: Uint8Array, windowBytes: number, limit: number) {
  const bytes = file.subarray(Math.max(0, file.byteLength - windowBytes));
  const partial = file.byteLength > bytes.byteLength;
  return markCutWindow(parseTail(decoder.decode(bytes), partial), partial).slice(-limit);
}

/** The incremental reader as the plugin drives it: read the window first, then only what was appended. */
class Follower {
  cursor: TailCursor | undefined;
  fullReads = 0;
  constructor(
    private readonly windowBytes: number,
    private readonly identity = 'dev:1',
  ) {}
  look(file: Uint8Array, limit: number, identity = this.identity) {
    const size = file.byteLength;
    let next: TailCursor | undefined;
    if (this.cursor !== undefined && canAdvance(this.cursor, identity, size)) {
      const from = advanceFrom(this.cursor);
      next = advanceCursor(this.cursor, file.subarray(from, size), size);
    }
    if (next === undefined) {
      this.fullReads += 1;
      next = openCursor(identity, file.subarray(Math.max(0, size - this.windowBytes)), size, this.windowBytes);
    }
    this.cursor = next;
    return windowRecords(next, limit);
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
};

describe('the incremental tail', () => {
  test('growth in odd pieces (cutting lines and characters) always equals one parse of the window', () => {
    for (const windowBytes of [64, 300, 1_000, 100_000]) {
      const follower = new Follower(windowBytes);
      let file: Uint8Array = new Uint8Array(0);
      let n = 0;
      const text = Array.from({ length: 120 }, (_, i) => record(i) + '\n').join('');
      const all = encoder.encode(text);
      // Deterministic odd chunk sizes: 1 byte, a few, a line and a half.
      for (let at = 0; at < all.byteLength; n += 1) {
        const size = [1, 7, 33, 90, 3, 211][n % 6] ?? 1;
        file = all.subarray(0, Math.min(all.byteLength, at + size));
        at = file.byteLength;
        for (const limit of [4, 1_000]) expect(follower.look(file, limit)).toEqual(reference(file, windowBytes, limit));
      }
      // Steady state reads only what was appended: with a window the file fits in, the one first read is the only full one.
      if (windowBytes >= 100_000) expect(follower.fullReads).toBe(1);
    }
  });

  test('a last line with no newline yet is read as it is, and read again with the rest of it', () => {
    const follower = new Follower(10_000);
    const first = encoder.encode(`${record(0)}\n${record(4)}`);
    expect(follower.look(first, 100)).toEqual(reference(first, 10_000, 100));
    expect(follower.look(first, 100).at(-1)?.kind).toBe('turn');
    const cutMid = encoder.encode(`${record(0)}\n${record(4).slice(0, 20)}`);
    const grown = concat(cutMid, encoder.encode(`${record(4).slice(20)}\n${record(1)}\n`));
    expect(follower.look(cutMid, 100)).toEqual(reference(cutMid, 10_000, 100));
    expect(follower.look(grown, 100)).toEqual(reference(grown, 10_000, 100));
  });

  test('a file that got smaller starts over, and answers what the smaller file says', () => {
    const follower = new Follower(500);
    const big = encoder.encode(Array.from({ length: 40 }, (_, i) => record(i) + '\n').join(''));
    follower.look(big, 50);
    const small = encoder.encode(`${record(4)}\n`);
    const before = follower.fullReads;
    expect(follower.look(small, 50)).toEqual(reference(small, 500, 50));
    expect(follower.fullReads).toBe(before + 1);
  });

  test('a replaced file (another identity) starts over even when it is larger', () => {
    const follower = new Follower(500);
    const one = encoder.encode(Array.from({ length: 6 }, (_, i) => record(i) + '\n').join(''));
    follower.look(one, 50, 'dev:1');
    const other = encoder.encode(Array.from({ length: 12 }, (_, i) => record(i + 3) + '\n').join(''));
    const before = follower.fullReads;
    expect(follower.look(other, 50, 'dev:2')).toEqual(reference(other, 500, 50));
    expect(follower.fullReads).toBe(before + 1);
  });

  test('a file rewritten in place (the byte before the new part is no newline) is not trusted: it starts over', () => {
    const follower = new Follower(10_000);
    const one = encoder.encode(`${record(0)}\n${record(1)}\n`);
    follower.look(one, 50);
    // Same identity and bigger, but the old content is not the prefix: the byte before the appended part is not "\n".
    const rewritten = encoder.encode(`${record(3)}\n${record(2)}\n${record(4)}\n${record(1)}\n`.replace('\n', ' '));
    const before = follower.fullReads;
    expect(follower.look(rewritten, 50)).toEqual(reference(rewritten, 10_000, 50));
    expect(follower.fullReads).toBe(before + 1);
  });

  test('growth past what the window holds is one full read (no dearer than today)', () => {
    const follower = new Follower(200);
    const one = encoder.encode(`${record(0)}\n`);
    follower.look(one, 50);
    const burst = concat(one, encoder.encode(Array.from({ length: 30 }, (_, i) => record(i) + '\n').join('')));
    const before = follower.fullReads;
    expect(follower.look(burst, 50)).toEqual(reference(burst, 200, 50));
    expect(follower.fullReads).toBe(before + 1);
  });

  test('one record bigger than the window keeps the turn at work, as the full parse does', () => {
    const follower = new Follower(100);
    const huge = encoder.encode(`${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(2_000) } })}\n`);
    expect(follower.look(huge, 50)).toEqual(reference(huge, 100, 50));
    const more = concat(huge, encoder.encode(`${record(1)}\n`));
    expect(follower.look(more, 50)).toEqual(reference(more, 100, 50));
  });
});
