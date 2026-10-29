import { describe, it } from 'bun:test';
import should from 'should';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import {
  PacedTranscriptParser,
  PARSE_SLICE_BYTES,
  parseTranscriptInSlices,
  type TranscriptParsePacing,
} from '../../../src/lib/transcript/sliced.ts';
import type { TranscriptParser } from '../../../src/lib/transcript/types.ts';
import claudeFixture from '../../fixtures/transcript/claude.jsonl' with { type: 'text' };
import codexFixture from '../../fixtures/transcript/codex.jsonl' with { type: 'text' };

const COMMON = {
  source: '/fixture.jsonl',
  sessionId: 'fixture-session',
  startLine: 7,
  startByteOffset: 1_024,
  observedAt: '2026-10-21T00:00:00.000Z',
} as const;

/** A clock that never advances, so no slice ever runs past the budget and nothing yields. */
const FROZEN: TranscriptParsePacing = { now: () => 0, yieldToLoop: async () => undefined };

/** A clock that moves `step` milliseconds a reading, with the yields it was asked for counted. */
function countedPacing(step: number): TranscriptParsePacing & { readonly yields: () => number } {
  let clock = 0;
  let yields = 0;
  return {
    now: () => {
      clock += step;
      return clock;
    },
    yieldToLoop: async () => {
      yields += 1;
    },
    yields: () => yields,
  };
}

/**
 * A fixture repeated until it is far past one slice, with the shapes a slice boundary could break: a
 * record longer than a whole slice, a malformed record, a blank line, characters of every UTF-8 width,
 * and an unterminated final line.
 */
function largeText(fixture: string, copies: number): string {
  const lines = fixture.trimEnd().split('\n');
  const wide = JSON.stringify({ type: 'user', note: `é漢😀${'x'.repeat(300 * 1024)}` });
  const body = Array.from({ length: copies }, (_, index) =>
    index === Math.floor(copies / 2) ? [...lines, wide, '{"truncated', ''].join('\n') : lines.join('\n'),
  ).join('\n');
  return `${body}\n${lines[0]?.slice(0, 20) ?? ''}`;
}

function wholeBytes(parser: TranscriptParser, bytes: Uint8Array, endOfInput = true) {
  return parser.parse({ ...COMMON, bytes, endOfInput }, parser.createInputObserver());
}

describe('parseTranscriptInSlices', () => {
  for (const [name, parser, fixture] of [
    ['Claude', new ClaudeTranscriptParser(), claudeFixture],
    ['Codex', new CodexTranscriptParser(), codexFixture],
  ] as const) {
    it(`should parse a large ${name} read's bytes exactly as one whole parse does`, async () => {
      // Arrange
      const bytes = new TextEncoder().encode(largeText(fixture, 1_500));

      // Act
      const sliced = await parseTranscriptInSlices(parser, { ...COMMON, bytes, endOfInput: true }, FROZEN);

      // Assert
      should(bytes.byteLength).be.above(PARSE_SLICE_BYTES * 4);
      should(sliced.events.length).be.above(0);
      should(sliced).deepEqual(wholeBytes(parser, bytes));
    });

    it(`should parse a large ${name} text exactly as one whole parse does, byte offsets included`, async () => {
      // Arrange
      const text = largeText(fixture, 1_500);

      // Act
      const sliced = await parseTranscriptInSlices(parser, { ...COMMON, text, endOfInput: false }, FROZEN);

      // Assert
      should(sliced.rawRecords).be.undefined();
      should(sliced).deepEqual(parser.parse({ ...COMMON, text, endOfInput: false }, parser.createInputObserver()));
    });
  }

  it('should parse pieces of one read as the read itself, wherever the pieces are cut on a record terminator', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();
    const bytes = new TextEncoder().encode(largeText(claudeFixture, 600));
    const firstFeed = bytes.indexOf(0x0a);
    const lastFeed = bytes.lastIndexOf(0x0a);
    const pieces = [
      bytes.subarray(0, firstFeed + 1),
      new Uint8Array(),
      bytes.subarray(firstFeed + 1, lastFeed + 1),
      bytes.subarray(lastFeed + 1),
    ];

    // Act
    const sliced = await parseTranscriptInSlices(parser, { ...COMMON, bytes: pieces, endOfInput: false }, FROZEN);

    // Assert
    should(sliced).deepEqual(wholeBytes(parser, bytes, false));
  });

  it('should parse no pieces as one whole parse of nothing', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();

    // Act
    const sliced = await parseTranscriptInSlices(parser, { ...COMMON, bytes: [new Uint8Array()] }, FROZEN);

    // Assert
    should(sliced).deepEqual(wholeBytes(parser, new Uint8Array()));
    should(sliced.rawRecords).deepEqual([]);
  });

  it('should count every UTF-8 width the way the encoder does, lone surrogates included', async () => {
    // Arrange — a lone high surrogate before a newline, one ending the input, and a lone low one.
    const parser = new ClaudeTranscriptParser();
    // Written raw: `JSON.stringify` would escape a lone surrogate to six ASCII characters.
    const record = (note: string): string => `{"type":"user","note":"${note}"}`;
    const line = `${record(`é漢😀\udc00${'y'.repeat(PARSE_SLICE_BYTES)}`)}\n`;
    const text = `${line}${record('\ud800')}\n${line}{"note":"\ud800`;

    // Act
    const sliced = await parseTranscriptInSlices(parser, { ...COMMON, text, endOfInput: false }, FROZEN);

    // Assert
    should(sliced).deepEqual(parser.parse({ ...COMMON, text, endOfInput: false }, parser.createInputObserver()));
    should(sliced.parsedRecords).equal(3);
    should(sliced.issues.map(issue => issue.code)).deepEqual(['incomplete-line']);
  });

  it('should parse a final record longer than a slice whole, unterminated', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();
    const head = `${claudeFixture.trimEnd()}\n`;
    const text = `${head}${JSON.stringify({ type: 'user', note: 'z'.repeat(PARSE_SLICE_BYTES * 2) })}`;

    // Act
    const sliced = await parseTranscriptInSlices(parser, { ...COMMON, text, endOfInput: true }, FROZEN);

    // Assert
    should(sliced).deepEqual(parser.parse({ ...COMMON, text, endOfInput: true }, parser.createInputObserver()));
    should(sliced.remainder).equal('');
  });

  it('should hand the loop back between slices once a slice runs past the budget, and never after the last', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();
    const bytes = new TextEncoder().encode(largeText(claudeFixture, 1_500));
    const pacing = countedPacing(1_000);

    // Act
    await parseTranscriptInSlices(parser, { bytes, endOfInput: true }, pacing);

    // Assert — every slice after the first waited for the loop, and the last one did not wait after it.
    const slices = Math.ceil(bytes.byteLength / PARSE_SLICE_BYTES);
    should(pacing.yields()).be.within(slices - 2, slices);
    should(pacing.yields()).be.above(3);
  });

  it('should never hand the loop back while slices stay inside the budget', async () => {
    // Arrange
    const parser = new ClaudeTranscriptParser();
    const bytes = new TextEncoder().encode(largeText(claudeFixture, 1_500));
    const pacing = countedPacing(0);

    // Act
    await parseTranscriptInSlices(parser, { bytes, endOfInput: true }, pacing);

    // Assert
    should(pacing.yields()).equal(0);
  });
});

describe('PacedTranscriptParser', () => {
  it('should parse through the slices with the pacing it was given, as the parser it wraps', async () => {
    // Arrange
    const parser = new CodexTranscriptParser();
    const pacing = countedPacing(1_000);
    const subject = new PacedTranscriptParser(parser, pacing);
    const text = largeText(codexFixture, 1_500);

    // Act
    const parsed = await subject.parse({ ...COMMON, text, endOfInput: true });

    // Assert
    should(subject.harness).equal('codex');
    should(parsed).deepEqual(parser.parse({ ...COMMON, text, endOfInput: true }, parser.createInputObserver()));
    should(pacing.yields()).be.above(0);
  });
});
