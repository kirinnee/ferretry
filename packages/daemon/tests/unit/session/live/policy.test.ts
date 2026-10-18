import { describe, it } from 'bun:test';
import type { SessionLiveActivity } from '@ferretry/protocol';
import should from 'should';
import {
  liveActivitySample,
  paneLiveReading,
  sameLiveReading,
  tokenCounterValue,
  turnTokensSince,
} from '../../../../src/lib/session/live/policy.ts';
import type { TranscriptEvent, TranscriptHarness } from '../../../../src/lib/transcript/types.ts';

/**
 * The live readout's reading rules.
 *
 * WHAT THESE HAVE TO GET RIGHT. A readout is a number a person watches climb, so the failure that
 * matters is a number that is quietly wrong: an `↑` counter taken for output, a partial sum shown as
 * the turn's total, one reply counted once per content block, or a previous turn's usage leaking into
 * this one. Every case here pins a refusal or a boundary, not just the happy sum.
 */

const START = Date.parse('2026-10-18T10:00:00.000Z');
const atMs = (offsetSeconds: number): string => new Date(START + offsetSeconds * 1_000).toISOString();

const user = (offsetSeconds: number | undefined): TranscriptEvent => ({
  harness: 'claude',
  role: 'user',
  kind: 'message',
  text: 'go',
  ...(offsetSeconds === undefined ? {} : { timestamp: atMs(offsetSeconds) }),
});

const assistantSaid = (offsetSeconds: number): TranscriptEvent => ({
  harness: 'claude',
  role: 'assistant',
  kind: 'message',
  text: 'ok',
  timestamp: atMs(offsetSeconds),
});

interface UsageInput {
  readonly output?: number;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly messageId?: string;
  readonly harness?: TranscriptHarness;
  /** `undefined` leaves the record without a timestamp at all. */
  readonly at?: number | string | undefined;
}

const usage = (spec: UsageInput): TranscriptEvent => ({
  harness: spec.harness ?? 'claude',
  role: 'assistant',
  kind: 'usage',
  ...(spec.at === undefined ? {} : { timestamp: typeof spec.at === 'string' ? spec.at : atMs(spec.at) }),
  ...(spec.messageId === undefined ? {} : { messageId: spec.messageId }),
  usage: {
    ...(spec.input === undefined ? {} : { inputTokens: spec.input }),
    ...(spec.output === undefined ? {} : { outputTokens: spec.output }),
    ...(spec.cacheRead === undefined ? {} : { cachedInputTokens: spec.cacheRead }),
    ...(spec.cacheWrite === undefined ? {} : { cacheCreationInputTokens: spec.cacheWrite }),
  },
});

describe('tokenCounterValue', () => {
  it('should scale k and M in either case and read plain and comma-grouped numbers', () => {
    should(tokenCounterValue('3.1', 'k')).equal(3_100);
    should(tokenCounterValue('3.1', 'K')).equal(3_100);
    should(tokenCounterValue('1.2', 'M')).equal(1_200_000);
    should(tokenCounterValue('1.2', 'm')).equal(1_200_000);
    should(tokenCounterValue('12,345', '')).equal(12_345);
    should(tokenCounterValue('0', '')).equal(0);
  });

  it('should round a fractional count to a whole token', () => {
    should(tokenCounterValue('1.0004', 'k')).equal(1_000);
    should(tokenCounterValue('2.5', '')).equal(3);
  });

  it('should answer nothing for what is not a count', () => {
    // A counter that does not parse is absent, never zero: zero would read as "measured, none".
    should(tokenCounterValue('1.2.3', 'k')).be.undefined();
    should(tokenCounterValue('-4', '')).be.undefined();
    should(tokenCounterValue('Infinity', '')).be.undefined();
    should(tokenCounterValue('abc', 'k')).be.undefined();
  });
});

describe('paneLiveReading', () => {
  it("should read Claude's verb and its output counter off the spinner line", () => {
    // Arrange
    const frame = ['⏺ Reading file.', '', '✽ Pontificating… (42s · ↓ 3.1k tokens · esc to interrupt)', '', '│ > '].join(
      '\n',
    );

    // Act / Assert
    should(paneLiveReading(frame)).deepEqual({ verb: 'Pontificating…', outputTokens: 3_100 });
  });

  it('should read every unit the counter is printed in', () => {
    const read = (counter: string) => paneLiveReading(`✻ Cooking… (1s · ${counter} · esc to interrupt)`);

    should(read('↓ 987 tokens')).deepEqual({ verb: 'Cooking…', outputTokens: 987 });
    should(read('↓ 12,345 tokens')).deepEqual({ verb: 'Cooking…', outputTokens: 12_345 });
    should(read('↓ 3.1K tokens')).deepEqual({ verb: 'Cooking…', outputTokens: 3_100 });
    should(read('↓ 1.2M tokens')).deepEqual({ verb: 'Cooking…', outputTokens: 1_200_000 });
    // A bare count with no arrow is the same counter on a harness version that omits it.
    should(read('12k tokens')).deepEqual({ verb: 'Cooking…', outputTokens: 12_000 });
    should(read('↓ 1 token')).deepEqual({ verb: 'Cooking…', outputTokens: 1 });
  });

  it('should ignore an input (↑) counter rather than report it as output', () => {
    // Arrange — the ↑ number is what was SENT; showing it as written would inflate the readout.
    const frame = '✽ Pontificating… (42s · ↑ 9.9k tokens · esc to interrupt)';

    // Act / Assert — the verb is still true, the count is simply absent.
    should(paneLiveReading(frame)).deepEqual({ verb: 'Pontificating…' });
  });

  it('should take the output counter even when an input counter sits beside it', () => {
    should(paneLiveReading('✽ Thinking… (5s · ↑ 9.9k tokens · ↓ 2k tokens)')).deepEqual({
      verb: 'Thinking…',
      outputTokens: 2_000,
    });
  });

  it('should keep the verb when the counter is not a count', () => {
    // `1.2.3k` satisfies the counter's shape but is not a number.
    should(paneLiveReading('✽ Thinking… (5s · ↓ 1.2.3k tokens)')).deepEqual({ verb: 'Thinking…' });
  });

  it('should read a status line that has no parenthetical, or whose parenthetical is cut off', () => {
    should(paneLiveReading('✻ Thinking…')).deepEqual({ verb: 'Thinking…' });
    should(paneLiveReading('· Churning… (3s · ↓ 40 tokens')).deepEqual({ verb: 'Churning…', outputTokens: 40 });
  });

  it("should read Codex's working line, with no counter", () => {
    should(paneLiveReading('• Working (6m52s • Esc to interrupt)\n\n› ')).deepEqual({ verb: 'Working…' });
    should(paneLiveReading('◦ Booting MCP server (2s • Esc to interrupt)')).deepEqual({ verb: 'Booting MCP server…' });
  });

  it('should answer nothing when the frame shows no status line', () => {
    should(paneLiveReading('')).be.undefined();
    should(paneLiveReading('  ? for shortcuts\n╭──────╮\n│ > ')).be.undefined();
    // Prose that merely mentions tokens is not a status line.
    should(paneLiveReading('The model used 3.1k tokens this turn.')).be.undefined();
  });

  it('should prefer the lowest status line, because that is the live one', () => {
    const frame = ['✻ Old… (9s · ↓ 1k tokens)', 'some output', '✽ Fresh… (2s · ↓ 2k tokens)', '', '│ > '].join('\n');

    should(paneLiveReading(frame)).deepEqual({ verb: 'Fresh…', outputTokens: 2_000 });
  });

  it('should look only at the bottom of the frame and accept CRLF line ends', () => {
    // Arrange — a stale spinner line scrolled 30 lines up must not be read as live.
    const stale = ['✽ Stale… (9s · ↓ 1k tokens)', ...Array.from({ length: 30 }, () => 'output')].join('\n');
    const crlf = '✽ Fresh… (2s · ↓ 2k tokens)\r\n\r\n│ > ';

    // Act / Assert
    should(paneLiveReading(stale)).be.undefined();
    should(paneLiveReading(crlf)).deepEqual({ verb: 'Fresh…', outputTokens: 2_000 });
  });
});

describe('turnTokensSince', () => {
  it('should sum a turn whose opening message sits just before the recorded boundary', () => {
    // Arrange — the watcher noticed the turn 3 seconds after the person's message; the call made
    // between the two belongs to this turn, and the previous turn's call before the message does not.
    const events = [
      usage({ at: -30, messageId: 'old', output: 999, input: 999 }),
      user(-3),
      usage({ at: -2, messageId: 'm1', output: 10, input: 100 }),
      usage({ at: 5, messageId: 'm2', output: 20, input: 200 }),
    ];

    // Act / Assert
    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 30, inputTokens: 300 });
  });

  it('should open at the recorded boundary when the message is far older (a resume or queued send)', () => {
    // Arrange — the last message is a minute before the turn the daemon recorded, so it is not this
    // turn's opener, and nothing the turn did before its own start is counted.
    const events = [
      user(-60),
      usage({ at: -30, messageId: 'm0', output: 500, input: 500 }),
      usage({ at: 1, messageId: 'm1', output: 7, input: 70 }),
    ];

    // Act / Assert
    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 7, inputTokens: 70 });
  });

  it('should treat a message stamped after the boundary as opening at the boundary', () => {
    // Arrange — the person's message lands a second after the daemon's recorded start (clock skew).
    const events = [user(1), usage({ at: 0.5, messageId: 'm', output: 4, input: 40 })];

    // Act / Assert — `min(at, boundary)`: the turn cannot begin later than the daemon says it did.
    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 4, inputTokens: 40 });
  });

  it('should use the newest user message, skipping assistant messages and unstamped ones', () => {
    // Arrange
    const events = [
      user(-8),
      usage({ at: -7, messageId: 'early', output: 1, input: 1 }),
      user(-4),
      usage({ at: -3, messageId: 'mid', output: 5, input: 50 }),
      assistantSaid(2),
      user(undefined),
    ];

    // Act / Assert — the newest STAMPED user message opens the turn, so `early` is excluded.
    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 5, inputTokens: 50 });
  });

  it('should count a reply once, at its largest, however many records it was written as', () => {
    // Arrange — Claude writes one record per content block of a reply, each carrying the reply's usage.
    const events = [
      usage({ at: 1, messageId: 'm1', output: 10, input: 100 }),
      usage({ at: 2, messageId: 'm1', output: 40, input: 120 }),
      usage({ at: 3, messageId: 'm1', output: 25, input: 90 }),
      usage({ at: 4, messageId: 'm2', output: 5, input: 10 }),
    ];

    // Act / Assert — m1 contributes max(output)=40, max(input)=120; m2 adds its own.
    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 45, inputTokens: 130 });
  });

  it('should count records with no message id separately', () => {
    const events = [usage({ at: 1, output: 3, input: 30 }), usage({ at: 2, output: 4, input: 40 })];

    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 7, inputTokens: 70 });
  });

  it('should count Claude input as fresh plus cache read plus cache write', () => {
    const events = [usage({ at: 1, messageId: 'm', output: 1, input: 100, cacheRead: 50, cacheWrite: 25 })];

    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 1, inputTokens: 175 });
  });

  it('should count Codex input as the reported input alone', () => {
    // Codex already folds its cached tokens into `input_tokens`; adding the cached count again would
    // count them twice.
    const events = [usage({ harness: 'codex', at: 1, output: 2, input: 100, cacheRead: 80 })];

    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 2, inputTokens: 100 });
  });

  it('should count a usage record that omits a field as zero for that field', () => {
    should(turnTokensSince([usage({ at: 1, messageId: 'm', output: 6 })], START, true)).deepEqual({
      outputTokens: 6,
      inputTokens: 0,
    });
    should(turnTokensSince([usage({ at: 1, harness: 'codex', input: 9 })], START, true)).deepEqual({
      outputTokens: 0,
      inputTokens: 9,
    });
  });

  it('should answer an empty object, not zeros, when the turn has no usage yet', () => {
    // Arrange — absent is unknown, never zero.
    should(turnTokensSince([], START, true)).deepEqual({});
    should(turnTokensSince([user(-1), assistantSaid(1)], START, true)).deepEqual({});
    // Only the previous turn's usage, and a record with no usable time, are not this turn's.
    should(turnTokensSince([usage({ at: -30, messageId: 'old', output: 5 })], START, true)).deepEqual({});
    should(turnTokensSince([usage({ at: undefined, output: 5 })], START, true)).deepEqual({});
    should(turnTokensSince([usage({ at: 'not a time', output: 5 })], START, true)).deepEqual({});
  });

  it('should say nothing when an incomplete tail does not reach back to the turn start', () => {
    // Arrange — the tail was cut: its oldest event is already inside the turn, so earlier calls of
    // this turn were lost. A partial sum shown as the total would be a lie.
    const events = [usage({ at: 5, messageId: 'm1', output: 10, input: 100 })];

    // Act / Assert
    should(turnTokensSince(events, START, false)).be.undefined();
  });

  it('should say nothing when an incomplete tail has no stamped event to prove it reaches back', () => {
    should(turnTokensSince([user(undefined), usage({ at: undefined, output: 1 })], START, false)).be.undefined();
    should(turnTokensSince([], START, false)).be.undefined();
  });

  it('should sum an incomplete tail that does reach the turn start', () => {
    // Arrange — the oldest event is from before the boundary, so nothing of this turn was cut off.
    const events = [assistantSaid(-120), usage({ at: 3, messageId: 'm', output: 8, input: 80 })];

    // Act / Assert
    should(turnTokensSince(events, START, false)).deepEqual({ outputTokens: 8, inputTokens: 80 });
  });

  it('should sum a complete tail even when its oldest event is inside the turn', () => {
    // A complete tail is the whole transcript: the turn starts at its first line, not later.
    const events = [usage({ at: 5, messageId: 'm', output: 8, input: 80 })];

    should(turnTokensSince(events, START, true)).deepEqual({ outputTokens: 8, inputTokens: 80 });
  });
});

describe('liveActivitySample', () => {
  const AT = atMs(10);
  const TURN = atMs(0);

  it('should carry only the session and the instant when no turn is working', () => {
    // Arrange — even a pane that still looks busy must not invent a turn.
    const sample = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: undefined,
      pane: { verb: 'Working…', outputTokens: 5 },
      transcript: { outputTokens: 9, inputTokens: 9 },
    });

    // Assert
    should(sample).deepEqual({ sessionId: 's1', at: AT });
  });

  it('should carry the turn and nothing else when neither source has anything', () => {
    should(
      liveActivitySample({ sessionId: 's1', at: AT, turnStartedAt: TURN, pane: undefined, transcript: undefined }),
    ).deepEqual({ sessionId: 's1', at: AT, turnStartedAt: TURN });
    should(
      liveActivitySample({ sessionId: 's1', at: AT, turnStartedAt: TURN, pane: undefined, transcript: {} }),
    ).deepEqual({ sessionId: 's1', at: AT, turnStartedAt: TURN });
  });

  it('should take output from the pane when it is at least the transcript, and input from the transcript', () => {
    const ahead = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: { verb: 'Pontificating…', outputTokens: 120 },
      transcript: { outputTokens: 100, inputTokens: 5_000 },
    });
    const level = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: { verb: 'Pontificating…', outputTokens: 100 },
      transcript: { outputTokens: 100, inputTokens: 5_000 },
    });

    should(ahead).deepEqual({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      verb: 'Pontificating…',
      outputTokens: 120,
      outputSource: 'pane',
      inputTokens: 5_000,
    });
    // A tie goes to the pane: it is the harness's own number.
    should(level.outputSource).equal('pane');
  });

  it('should take output from the transcript when the pane is behind it', () => {
    const sample = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: { verb: 'Working…', outputTokens: 80 },
      transcript: { outputTokens: 100, inputTokens: 7 },
    });

    should(sample).deepEqual({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      verb: 'Working…',
      outputTokens: 100,
      outputSource: 'transcript',
      inputTokens: 7,
    });
  });

  it('should fall back to the transcript when the pane shows a verb but no counter', () => {
    const sample = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: { verb: 'Working…' },
      transcript: { outputTokens: 33 },
    });

    should(sample).deepEqual({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      verb: 'Working…',
      outputTokens: 33,
      outputSource: 'transcript',
    });
  });

  it('should read the pane alone when the transcript has nothing', () => {
    const sample = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: { verb: 'Pondering…', outputTokens: 12 },
      transcript: undefined,
    });

    should(sample).deepEqual({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      verb: 'Pondering…',
      outputTokens: 12,
      outputSource: 'pane',
    });
  });

  it('should carry transcript input on its own, with no output source to attribute', () => {
    const sample = liveActivitySample({
      sessionId: 's1',
      at: AT,
      turnStartedAt: TURN,
      pane: undefined,
      transcript: { inputTokens: 400 },
    });

    should(sample).deepEqual({ sessionId: 's1', at: AT, turnStartedAt: TURN, inputTokens: 400 });
  });
});

describe('sameLiveReading', () => {
  const base: SessionLiveActivity = {
    sessionId: 's1',
    at: atMs(1),
    turnStartedAt: atMs(0),
    verb: 'Working…',
    outputTokens: 10,
    inputTokens: 100,
    outputSource: 'pane',
  };

  it('should say nothing is the same as no previous sample', () => {
    should(sameLiveReading(undefined, base)).be.false();
  });

  it('should ignore the instant a sample was taken', () => {
    // Arrange — a reading that only moved its timestamp says nothing new and must not be re-sent.
    should(sameLiveReading(base, { ...base, at: atMs(2) })).be.true();
  });

  it('should see a difference in any field a reader shows', () => {
    should(sameLiveReading(base, { ...base, sessionId: 's2' })).be.false();
    should(sameLiveReading(base, { ...base, turnStartedAt: atMs(5) })).be.false();
    should(sameLiveReading(base, { ...base, verb: 'Thinking…' })).be.false();
    should(sameLiveReading(base, { ...base, outputTokens: 11 })).be.false();
    should(sameLiveReading(base, { ...base, inputTokens: 101 })).be.false();
    should(sameLiveReading(base, { ...base, outputSource: 'transcript' })).be.false();
  });

  it('should tell a field going absent from a field staying absent', () => {
    const { verb: _verb, ...withoutVerb } = base;

    should(sameLiveReading(withoutVerb, withoutVerb)).be.true();
    should(sameLiveReading(base, withoutVerb)).be.false();
    should(sameLiveReading(withoutVerb, base)).be.false();
  });
});
