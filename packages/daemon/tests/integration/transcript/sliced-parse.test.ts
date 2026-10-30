/**
 * A LARGE TRANSCRIPT PARSE MUST NOT HOLD THE EVENT LOOP, AND MUST NOT CHANGE WHAT IT PARSES.
 *
 * A bounded read is up to 32 MiB, and it used to be parsed in one synchronous call: on a Mac with three
 * 200 MB transcripts the daemon's loop stalled for seconds per read and, with every boot loop reading at
 * once, stopped answering altogether. `parseInSlices` cuts the parse at record boundaries and yields
 * between slices. These prove the two halves of that: the result is exactly one whole parse's, for both
 * harnesses' real parsers, and a timer queued before a big parse runs before the parse finishes.
 */
import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { parseInSlices } from '../../../src/adapters/transcript/file-source.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import type { TranscriptParser } from '../../../src/lib/transcript/types.ts';

const FIXTURES = join(import.meta.dir, '../../fixtures/transcript');

/**
 * A fixture repeated until it is far past one slice, with the shapes a slice boundary could break: a
 * record longer than a whole slice, a malformed record, a blank line, and an unterminated final line.
 */
async function largeInput(fixture: string, copies: number): Promise<Uint8Array> {
  const base = (await readFile(join(FIXTURES, fixture), 'utf8')).trimEnd();
  const lines = base.split('\n');
  const oversized = JSON.stringify({ type: 'user', note: 'x'.repeat(300 * 1024) });
  const body = Array.from({ length: copies }, (_, index) =>
    index === Math.floor(copies / 2) ? [...lines, oversized, '{"truncated', ''].join('\n') : lines.join('\n'),
  ).join('\n');
  return new TextEncoder().encode(`${body}\n${lines[0]?.slice(0, 20) ?? ''}`);
}

async function provesWholeParse(parser: TranscriptParser, fixture: string): Promise<void> {
  // Arrange
  const bytes = await largeInput(fixture, 500);
  const input = {
    source: '/fixture.jsonl',
    sessionId: 'fixture-session',
    endOfInput: true,
    startLine: 7,
    startByteOffset: 1_024,
    observedAt: '2026-10-21T00:00:00.000Z',
  };

  // Act
  const whole = parser.parse(
    { ...input, text: Buffer.from(bytes).toString('utf8'), bytes },
    parser.createInputObserver(),
  );
  const sliced = await parseInSlices(parser, { ...input, bytes }, parser.createInputObserver());

  // Assert
  should(bytes.byteLength).be.above(1024 * 1024);
  should(sliced.events.length).be.above(0);
  should(sliced).deepEqual(whole);
}

describe('parseInSlices', () => {
  it('should parse a large Claude transcript exactly as one whole parse does', async () => {
    await provesWholeParse(new ClaudeTranscriptParser(), 'claude.jsonl');
  });

  it('should parse a large Codex rollout exactly as one whole parse does', async () => {
    await provesWholeParse(new CodexTranscriptParser(), 'codex.jsonl');
  });

  it('should parse a small input in one call, unchanged', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();
    const bytes = new Uint8Array(await readFile(join(FIXTURES, 'claude.jsonl')));

    // Act
    const sliced = await parseInSlices(parser, { bytes, endOfInput: true });

    // Assert
    should(sliced).deepEqual(
      parser.parse(
        { text: Buffer.from(bytes).toString('utf8'), bytes, endOfInput: true },
        parser.createInputObserver(),
      ),
    );
  });

  it('should hand the event loop back while a large parse runs', async () => {
    // Arrange — a timer queued first runs before the parse settles only if the parse yields.
    const parser = new ClaudeTranscriptParser();
    const bytes = await largeInput('claude.jsonl', 6_000);
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);

    // Act
    await parseInSlices(parser, { bytes, endOfInput: true });
    order.push('parsed');

    // Assert
    should(order).deepEqual(['timer', 'parsed']);
  });
});
