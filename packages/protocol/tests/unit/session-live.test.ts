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
