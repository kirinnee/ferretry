/**
 * Proves the timeline arithmetic on a hand-moved clock: spans are measured even when the work throws,
 * the total stops at review, the bar's three parts always sum to the total, the slowest stage is the
 * longest one, and the summary reads only the newest dictations, grouped by engine and by provider.
 */
import { describe, it } from 'bun:test';
import type { CleanupTrace } from '@ferretry/protocol';
import should from 'should';
import {
  barSegments,
  type CleanupTiming,
  cleanupDetailsOf,
  DictationTimelineRecorder,
  DictationTimelineSchema,
  type DictationTimeline,
  percentile,
  slowestStage,
  summarizeTimelines,
  TIMING_SUMMARY_WINDOW,
  toComposerMs,
  tokensOf,
  withInsertion,
} from '../../../src/lib/stt/dictation-timeline.ts';

const clock = (start = 0) => {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

const cleanup = (overrides: Partial<CleanupTiming> = {}): CleanupTiming => ({
  provider: 'groq',
  via: 'device',
  outcome: 'cleaned',
  attempts: 1,
  totalMs: 300,
  ...overrides,
});

const timeline = (overrides: Partial<DictationTimeline> = {}): DictationTimeline => ({
  totalMs: 1_000,
  speech: { engine: 'parakeet', totalMs: 600 },
  cleanup: cleanup({ totalMs: 300 }),
  ...overrides,
});

describe('DictationTimelineRecorder', () => {
  it('measures an async span and a sync span on the clock it was given', async () => {
    // Arrange
    const c = clock(100);
    const recorder = new DictationTimelineRecorder(c.now);

    // Act
    await recorder.measure('speech', async () => {
      c.advance(250);
      return 'words';
    });
    recorder.measureSync('context', () => c.advance(7));

    // Assert
    should(recorder.spanMs('speech')).equal(250);
    should(recorder.spanMs('context')).equal(7);
    should(recorder.spanMs('cleanup')).be.undefined();
  });

  it('keeps the time of work that threw, and still throws', async () => {
    // Arrange
    const c = clock();
    const recorder = new DictationTimelineRecorder(c.now);

    // Act
    const failing = recorder.measure('cleanup', async () => {
      c.advance(900);
      throw new Error('provider down');
    });

    // Assert
    await should(failing).rejectedWith('provider down');
    should(recorder.spanMs('cleanup')).equal(900);
    should(() =>
      recorder.measureSync('context', () => {
        c.advance(3);
        throw new Error('nope');
      }),
    ).throw('nope');
    should(recorder.spanMs('context')).equal(3);
  });

  it('builds a timeline whose total runs from construction, and which parses', async () => {
    // Arrange
    const c = clock(5_000);
    const recorder = new DictationTimelineRecorder(c.now);
    await recorder.measure('speech', async () => c.advance(600));
    recorder.measureSync('context', () => c.advance(20));
    await recorder.measure('cleanup', async () => c.advance(300));
    c.advance(80);

    // Act
    const built = recorder.build({
      engine: 'parakeet',
      provider: 'on-device',
      session: { audioMs: 4_000, audioBytes: 256_000, prepareMs: 40, transcribeMs: 550, loadMs: 1_200.04, model: 'v3' },
      cleanup: cleanupDetailsOf({ provider: 'groq', model: 'm', via: 'device', outcome: 'cleaned' }),
    });

    // Assert
    should(built).eql({
      totalMs: 1_000,
      audio: { ms: 4_000, bytes: 256_000 },
      prepareMs: 40,
      speech: { engine: 'parakeet', provider: 'on-device', model: 'v3', totalMs: 550, loadMs: 1_200 },
      contextMs: 20,
      cleanup: { provider: 'groq', model: 'm', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 300 },
    });
    should(DictationTimelineSchema.safeParse(built).success).be.true();
  });

  it('falls back to its own span and the dictation’s audio length when the session says nothing', async () => {
    // Arrange
    const c = clock();
    const recorder = new DictationTimelineRecorder(c.now);
    await recorder.measure('speech', async () => c.advance(120));

    // Act
    const built = recorder.build({ engine: 'web-speech', audioMs: 2_500.04 });

    // Assert
    should(built).eql({ totalMs: 120, audio: { ms: 2_500 }, speech: { engine: 'web-speech', totalMs: 120 } });
  });

  it('leaves cleanup out unless it both ran and described itself', async () => {
    // Arrange
    const c = clock();
    const recorder = new DictationTimelineRecorder(c.now);
    const details = cleanupDetailsOf({ provider: 'groq', via: 'device', outcome: 'cleaned' });

    // Act / Assert: described but never ran
    should(recorder.build({ engine: 'parakeet', cleanup: details })).not.have.property('cleanup');

    // ran but did not describe itself
    await recorder.measure('cleanup', async () => c.advance(10));
    should(recorder.build({ engine: 'parakeet' })).not.have.property('cleanup');
  });
});

describe('withInsertion', () => {
  it('adds the insert and review times without touching the pipeline total', () => {
    // Arrange
    const before = timeline();

    // Act
    const after = withInsertion(before, { insertMs: 12.34, reviewMs: 4_000 });

    // Assert
    should(after.insertMs).equal(12.3);
    should(after.reviewMs).equal(4_000);
    should(after.totalMs).equal(before.totalMs);
    should(before).not.have.property('insertMs');
  });
});

describe('barSegments and slowestStage', () => {
  it('makes other what remains, so the parts sum to the total', () => {
    // Act
    const segments = barSegments(timeline());

    // Assert
    should(segments).eql([
      { stage: 'speech', ms: 600 },
      { stage: 'cleanup', ms: 300 },
      { stage: 'other', ms: 100 },
    ]);
  });

  it('never gives other a negative length', () => {
    should(barSegments(timeline({ totalMs: 500 })).at(2)?.ms).equal(0);
  });

  it('counts a dictation with no cleanup as zero cleanup', () => {
    const { cleanup: _dropped, ...rest } = timeline();
    should(barSegments(rest).at(1)?.ms).equal(0);
  });

  it('names the longest stage', () => {
    should(slowestStage(timeline())).equal('speech');
    should(slowestStage(timeline({ cleanup: cleanup({ totalMs: 900 }), totalMs: 1_700 }))).equal('cleanup');
    should(slowestStage(timeline({ totalMs: 2_000 }))).equal('other');
  });

  it('names nothing when nothing took time', () => {
    should(slowestStage({ totalMs: 0, speech: { engine: 'parakeet', totalMs: 0 } })).be.undefined();
  });
});

describe('toComposerMs', () => {
  it('adds insertion to the pipeline total, and leaves review time out', () => {
    should(toComposerMs(timeline())).equal(1_000);
    should(toComposerMs(timeline({ insertMs: 25, reviewMs: 9_000 }))).equal(1_025);
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    should(percentile(sorted, 50)).equal(50);
    should(percentile(sorted, 90)).equal(90);
    should(percentile(sorted, 100)).equal(100);
    should(percentile(sorted, 0)).equal(10);
    should(percentile([7], 90)).equal(7);
  });

  it('has no answer for nothing, and clamps a wild percentage', () => {
    should(percentile([], 50)).be.undefined();
    should(percentile([1, 2, 3], 900)).equal(3);
    should(percentile([1, 2, 3], -5)).equal(1);
  });
});

describe('summarizeTimelines', () => {
  it('groups speech by engine and cleanup by provider and path, busiest first', () => {
    // Arrange
    const entries = [
      { timeline: timeline({ speech: { engine: 'parakeet', totalMs: 100 }, cleanup: cleanup({ totalMs: 200 }) }) },
      { timeline: timeline({ speech: { engine: 'parakeet', totalMs: 300 }, cleanup: cleanup({ totalMs: 400 }) }) },
      {
        timeline: timeline({
          speech: { engine: 'web-speech', totalMs: 50 },
          cleanup: cleanup({ provider: 'cerebras', via: 'daemon', totalMs: 1_500 }),
        }),
      },
      { timeline: undefined },
    ];

    // Act
    const summary = summarizeTimelines(entries);

    // Assert
    should(summary.dictations).equal(3);
    should(summary.speech).eql([
      { key: 'parakeet', count: 2, medianMs: 100, p90Ms: 300 },
      { key: 'web-speech', count: 1, medianMs: 50, p90Ms: 50 },
    ]);
    should(summary.cleanup).eql([
      { key: 'groq/device', count: 2, medianMs: 200, p90Ms: 400 },
      { key: 'cerebras/daemon', count: 1, medianMs: 1_500, p90Ms: 1_500 },
    ]);
  });

  it('reads only the newest twenty timed dictations', () => {
    // Arrange: 25 timed entries, newest first; the 5 oldest are huge
    const entries = Array.from({ length: 25 }, (_, index) => ({
      timeline: timeline({ speech: { engine: 'parakeet', totalMs: index < 20 ? 100 : 99_999 } }),
    }));

    // Act
    const summary = summarizeTimelines(entries);

    // Assert
    should(TIMING_SUMMARY_WINDOW).equal(20);
    should(summary.dictations).equal(20);
    should(summary.speech).eql([{ key: 'parakeet', count: 20, medianMs: 100, p90Ms: 100 }]);
  });

  it('counts entries without a timeline against nothing', () => {
    should(summarizeTimelines([{}, { timeline: undefined }])).eql({ dictations: 0, speech: [], cleanup: [] });
  });

  it('lists a dictation without cleanup under speech only', () => {
    const { cleanup: _dropped, ...rest } = timeline();
    const summary = summarizeTimelines([{ timeline: rest }]);
    should(summary.speech.length).equal(1);
    should(summary.cleanup).eql([]);
  });
});

describe('tokensOf', () => {
  it('reads the counts a provider reply carries', () => {
    should(tokensOf({ usage: { prompt_tokens: 40, completion_tokens: 8 } })).eql({
      promptTokens: 40,
      completionTokens: 8,
    });
  });

  it('keeps only whole, non-negative counts, and survives any shape', () => {
    should(tokensOf({ usage: { prompt_tokens: -1, completion_tokens: 1.5 } })).eql({});
    should(tokensOf({ usage: { prompt_tokens: '40' } })).eql({});
    should(tokensOf({ usage: 'x' })).eql({});
    should(tokensOf(null)).eql({});
    should(tokensOf([1])).eql({});
  });
});

describe('cleanupDetailsOf', () => {
  const trace = (attempts: number, usage?: { promptTokens?: number; completionTokens?: number }): CleanupTrace =>
    ({
      via: 'daemon',
      provider: 'groq',
      model: 'm',
      host: 'h',
      totalMs: 1,
      outcome: 'cleaned',
      attempts: Array.from({ length: attempts }, (_, index) => ({
        withContext: index === 0,
        request: { host: 'h', path: '/', headers: {}, params: {}, messages: [] },
        ...(usage === undefined || index < attempts - 1
          ? {}
          : { response: { raw: '', content: '', verdict: 'cleaned', steps: [], usage } }),
        timings: { totalMs: 1 },
      })),
    }) as unknown as CleanupTrace;

  it('takes everything a device call measured', () => {
    should(
      cleanupDetailsOf({
        provider: 'groq',
        model: 'm',
        via: 'device',
        outcome: 'cleaned',
        device: { totalMs: 5, firstByteMs: 2, attempts: 2, retried: 'without-context', promptTokens: 9 },
      }),
    ).eql({
      provider: 'groq',
      model: 'm',
      via: 'device',
      outcome: 'cleaned',
      attempts: 2,
      retried: 'without-context',
      firstByteMs: 2,
      promptTokens: 9,
    });
  });

  it('takes a daemon call’s attempts and tokens from its trace, and its provider time from the reply', () => {
    should(
      cleanupDetailsOf({
        provider: 'cerebras',
        via: 'daemon',
        outcome: 'kept_raw',
        providerMs: 410,
        trace: trace(2, { promptTokens: 30, completionTokens: 4 }),
      }),
    ).eql({
      provider: 'cerebras',
      via: 'daemon',
      outcome: 'kept_raw',
      attempts: 2,
      retried: 'without-context',
      providerMs: 410,
      promptTokens: 30,
      completionTokens: 4,
    });
  });

  it('assumes one attempt, and says nothing it does not know', () => {
    should(cleanupDetailsOf({ provider: 'local', via: 'local', outcome: 'cleaned' })).eql({
      provider: 'local',
      via: 'local',
      outcome: 'cleaned',
      attempts: 1,
    });
  });
});
