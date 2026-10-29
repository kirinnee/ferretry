import { describe, it } from 'bun:test';
import should from 'should';
import * as live from '../../src/lib/session-live.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const sample = {
  sessionId: 'session-1',
  at: '2026-10-18T07:00:05.000Z',
  turnStartedAt: '2026-10-18T07:00:00.000Z',
  verb: 'Pontificating…',
  outputTokens: 3_100,
  inputTokens: 48_000,
  outputSource: 'transcript',
} satisfies live.SessionLiveActivity;

const cases: SchemaCase[] = [
  { name: 'live sample', schema: live.SessionLiveActivitySchema, value: sample },
  { name: 'tokens source', schema: live.SessionLiveTokensSourceSchema, value: 'pane' },
  { name: 'compaction basis', schema: live.SessionCompactionBasisSchema, value: 'history' },
  {
    name: 'running compaction',
    schema: live.SessionCompactionRunningSchema,
    value: { phase: 'running', startedAt: '2026-10-18T07:00:00.000Z', expectedMs: 60_000, basis: 'typical' },
  },
  {
    name: 'finished compaction',
    schema: live.SessionCompactionDoneSchema,
    value: { phase: 'done', endedAt: '2026-10-18T07:00:41.000Z' },
  },
  {
    name: 'compaction',
    schema: live.SessionCompactionSchema,
    value: { phase: 'done', endedAt: '2026-10-18T07:00:41.000Z', tokensBefore: 10 },
  },
  {
    name: 'transcript moved',
    schema: live.SessionTranscriptMovedSchema,
    value: { sessionId: 'session-1', at: '2026-10-18T07:00:06.000Z' },
  },
];

describe('the session live readout protocol', () => {
  it('should round-trip every exported schema', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(live, cases);
  });

  it('should ask for the stream with the flag value the daemon reads', () => {
    // Assert — a reader and the daemon agree on one spelling, from this one constant.
    should(live.SESSION_LIVE_STREAM_FLAG).equal('1');
    should(live.SESSION_TRANSCRIPT_STREAM_FLAG).equal('1');
  });

  it('should carry nothing but who moved and when, so a signal can never stand in for the transcript', () => {
    // Act
    const withContent = live.SessionTranscriptMovedSchema.safeParse({
      sessionId: 'session-1',
      at: '2026-10-18T07:00:06.000Z',
      text: 'a reply',
    });

    // Assert
    should(withContent.success).be.false();
  });

  it('should treat every count as optional so an unmeasured one stays unknown rather than zero', () => {
    // Arrange — a sample with nothing but who and when.
    const bare = { sessionId: 'session-1', at: '2026-10-18T07:00:05.000Z' };

    // Act
    const parsed = live.SessionLiveActivitySchema.parse(bare);

    // Assert — no count was invented for the fields nobody measured.
    should(parsed).deepEqual(bare);
    should(parsed).not.have.property('outputTokens');
    should(parsed).not.have.property('inputTokens');
  });

  it('should keep a measured zero distinct from an absent count', () => {
    // Act
    const parsed = live.SessionLiveActivitySchema.parse({ ...sample, outputTokens: 0, inputTokens: 0 });

    // Assert
    should(parsed.outputTokens).equal(0);
    should(parsed.inputTokens).equal(0);
  });

  it('should refuse a sample that could not be attributed or counted', () => {
    // Arrange
    const refused: SchemaCase[] = [
      { name: 'no session', schema: live.SessionLiveActivitySchema, value: { ...sample, sessionId: '' } },
      { name: 'no time', schema: live.SessionLiveActivitySchema, value: { ...sample, at: undefined } },
      { name: 'a negative count', schema: live.SessionLiveActivitySchema, value: { ...sample, outputTokens: -1 } },
      { name: 'a fractional count', schema: live.SessionLiveActivitySchema, value: { ...sample, inputTokens: 1.5 } },
      { name: 'an empty verb', schema: live.SessionLiveActivitySchema, value: { ...sample, verb: '' } },
      {
        name: 'a verb too long to print',
        schema: live.SessionLiveActivitySchema,
        value: { ...sample, verb: 'x'.repeat(81) },
      },
      { name: 'a made-up source', schema: live.SessionLiveActivitySchema, value: { ...sample, outputSource: 'guess' } },
      { name: 'an unknown field', schema: live.SessionLiveActivitySchema, value: { ...sample, cost: 1 } },
      {
        name: 'an unreadable turn start',
        schema: live.SessionLiveActivitySchema,
        value: { ...sample, turnStartedAt: 'now' },
      },
    ];

    // Act + Assert
    assertRejects(refused);
  });
});

describe('the compaction readout', () => {
  const running = {
    phase: 'running',
    startedAt: '2026-10-18T07:00:00.000Z',
    tokensBefore: 150_000,
    expectedMs: 60_000,
    basis: 'history',
  } satisfies live.SessionCompactionRunning;
  const done = {
    phase: 'done',
    trigger: 'auto',
    startedAt: '2026-10-18T07:00:00.000Z',
    endedAt: '2026-10-18T07:00:41.000Z',
    tokensBefore: 150_000,
    tokensAfter: 9_000,
  } satisfies live.SessionCompactionDone;

  it('should round-trip both phases through the one discriminated schema', () => {
    should(live.SessionCompactionSchema.parse(running)).deepEqual(running);
    should(live.SessionCompactionSchema.parse(done)).deepEqual(done);
    should(live.SessionCompactionSchema.parse({ phase: 'done', endedAt: done.endedAt })).deepEqual({
      phase: 'done',
      endedAt: done.endedAt,
    });
    should(live.SessionCompactionBasisSchema.parse('typical')).equal('typical');
    should(live.SessionCompactionRunningSchema.safeParse(running).success).be.true();
    should(live.SessionCompactionDoneSchema.safeParse(done).success).be.true();
  });

  it('should refuse an unknown phase, an unknown field, a non-positive estimate and an unknown basis', () => {
    should(live.SessionCompactionSchema.safeParse({ ...running, phase: 'queued' }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, percent: 101 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, percent: -1 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, percent: 4.5 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, tokensWritten: -1 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...done, percent: 40 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, expectedMs: 0 }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...running, basis: 'guess' }).success).be.false();
    should(live.SessionCompactionSchema.safeParse({ ...done, tokensAfter: -1 }).success).be.false();
  });

  it('should ride on a live sample as an optional field', () => {
    should(live.SessionLiveActivitySchema.parse({ ...sample, compaction: running }).compaction).deepEqual(running);
  });

  it('should carry the percent and tokens written the harness reported, both optional', () => {
    const reported = { ...running, percent: 49, tokensWritten: 37_400 };

    should(live.SessionCompactionSchema.parse(reported)).deepEqual(reported);
    should(live.SessionCompactionSchema.parse({ ...running, percent: 0 })).containDeep({ percent: 0 });
    should(live.SessionCompactionSchema.parse({ ...running, percent: 100 })).containDeep({ percent: 100 });
    should(live.SessionCompactionSchema.parse(running)).not.have.property('percent');
  });

  it('should have no estimator: a percentage is only ever the harness’s own', () => {
    should(live).not.have.property('compactionPercent');
    should(live).not.have.property('COMPACTION_PERCENT_CAP');
  });

  it('should state what a compaction freed only when both ends are known and the context shrank', () => {
    should(live.compactionFreed(done)).equal(141_000);
    should(live.compactionFreed({ phase: 'done', endedAt: done.endedAt, tokensBefore: 5 })).be.undefined();
    should(live.compactionFreed({ phase: 'done', endedAt: done.endedAt, tokensAfter: 5 })).be.undefined();
    should(live.compactionFreed({ ...done, tokensBefore: 10, tokensAfter: 20 })).be.undefined();
  });
});
