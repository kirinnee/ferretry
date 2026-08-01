import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_SEGMENTER_OPTIONS,
  frameRms,
  SilenceSegmenter,
  type SpeechSegment,
} from '../../../src/lib/stt/silence-segmenter.ts';

const SAMPLE_RATE = 16_000;
const FRAME = (DEFAULT_SEGMENTER_OPTIONS.frameMs / 1_000) * SAMPLE_RATE;

/** `frames` worth of a steady tone at `amplitude`, loud enough to be voice. */
const tone = (frames: number, amplitude = 0.3): Float32Array => {
  const samples = new Float32Array(frames * FRAME);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
};

const quiet = (frames: number): Float32Array => new Float32Array(frames * FRAME);

const segmenter = (): SilenceSegmenter => new SilenceSegmenter({ sampleRate: SAMPLE_RATE });

/** Frames of voice needed to clear `minVoicedMs`, plus a little headroom. */
const VOICED_FRAMES = Math.ceil(DEFAULT_SEGMENTER_OPTIONS.minVoicedMs / DEFAULT_SEGMENTER_OPTIONS.frameMs) + 2;
/** Frames of quiet that close a phrase. */
const PAUSE_FRAMES = Math.ceil(DEFAULT_SEGMENTER_OPTIONS.endSilenceMs / DEFAULT_SEGMENTER_OPTIONS.frameMs) + 1;

describe('frameRms', () => {
  it('measures the root-mean-square energy of one frame', () => {
    should(frameRms(new Float32Array([0.5, -0.5]))).be.approximately(0.5, 1e-9);
  });

  it('answers zero for an empty frame rather than NaN', () => {
    should(frameRms(new Float32Array(0))).equal(0);
  });
});

describe('SilenceSegmenter boundaries', () => {
  it('never cuts on silence alone', () => {
    const unit = segmenter();
    should(unit.push(quiet(100))).have.length(0);
    should(unit.flush()).have.length(0);
  });

  it('closes a phrase on a real pause, not on the clock', () => {
    const unit = segmenter();
    should(unit.push(tone(VOICED_FRAMES))).have.length(0);
    const segments = unit.push(quiet(PAUSE_FRAMES));

    should(segments).have.length(1);
    const segment = segments[0] as SpeechSegment;
    should(segment.reason).equal('silence');
    should(segment.id).equal(0);
    should(segment.voicedMs).be.aboveOrEqual(DEFAULT_SEGMENTER_OPTIONS.minVoicedMs);
    should(segment.endSample).be.above(segment.startSample);
  });

  it('keeps the pre-roll, so the first consonant does not disappear', () => {
    const unit = segmenter();
    unit.push(quiet(40));
    unit.push(tone(VOICED_FRAMES));
    const segments = unit.push(quiet(PAUSE_FRAMES));

    const segment = segments[0] as SpeechSegment;
    should(segment.durationMs).be.above(segment.voicedMs);
    // Bounded by the pre-roll rather than by everything that was ever quiet.
    should(segment.durationMs - segment.voicedMs).be.below(
      DEFAULT_SEGMENTER_OPTIONS.preRollMs + DEFAULT_SEGMENTER_OPTIONS.endSilenceMs + DEFAULT_SEGMENTER_OPTIONS.frameMs,
    );
  });

  it('holds a cough back rather than sending a fragment to the model', () => {
    const unit = segmenter();
    unit.push(tone(6));
    should(unit.push(quiet(PAUSE_FRAMES * 3))).have.length(0);
    should(unit.flush()).have.length(0);
  });

  it('joins a held sub-minimum sound onto the phrase that follows it', () => {
    const unit = segmenter();
    unit.push(tone(6));
    unit.push(quiet(PAUSE_FRAMES * 2));
    unit.push(tone(VOICED_FRAMES));
    const segments = unit.push(quiet(PAUSE_FRAMES));

    should(segments).have.length(1);
    should((segments[0] as SpeechSegment).reason).equal('silence');
  });

  it('emits several phrases from one push, numbered in order', () => {
    const unit = segmenter();
    const phrase = tone(VOICED_FRAMES);
    const pause = quiet(PAUSE_FRAMES);
    const both = new Float32Array(phrase.length * 2 + pause.length * 2);
    both.set(phrase, 0);
    both.set(pause, phrase.length);
    both.set(phrase, phrase.length + pause.length);
    both.set(pause, phrase.length * 2 + pause.length);

    const segments = unit.push(both);
    should(segments).have.length(2);
    should(segments.map(segment => segment.id)).deepEqual([0, 1]);
  });

  it('cuts a long phrase at the soft limit only at a quiet boundary', () => {
    const unit = new SilenceSegmenter({
      sampleRate: SAMPLE_RATE,
      softMaxMs: 400,
      softCutSilenceMs: 40,
      minVoicedMs: 100,
      endSilenceMs: 2_000,
    });
    unit.push(tone(30));
    const segments = unit.push(quiet(3));

    should(segments).have.length(1);
    should((segments[0] as SpeechSegment).reason).equal('soft-limit');
  });

  it('does not cut at the soft limit while the reader is still talking', () => {
    const unit = new SilenceSegmenter({
      sampleRate: SAMPLE_RATE,
      softMaxMs: 200,
      softCutSilenceMs: 40,
      minVoicedMs: 100,
      endSilenceMs: 2_000,
    });
    should(unit.push(tone(60))).have.length(0);
  });
});

describe('SilenceSegmenter lifecycle', () => {
  it('emits the tail on flush, including the final partial frame', () => {
    const unit = segmenter();
    unit.push(tone(VOICED_FRAMES));
    unit.push(new Float32Array(FRAME / 2).fill(0.3));

    const segments = unit.flush();
    should(segments).have.length(1);
    should((segments[0] as SpeechSegment).reason).equal('flush');
  });

  it('is terminal: a second flush and any later push do nothing', () => {
    const unit = segmenter();
    unit.push(tone(VOICED_FRAMES));
    should(unit.flush()).have.length(1);
    should(unit.flush()).have.length(0);
    should(unit.push(tone(VOICED_FRAMES))).have.length(0);
  });

  it('ignores an empty push', () => {
    should(segmenter().push(new Float32Array(0))).have.length(0);
  });

  it('reports what it is still holding', () => {
    const unit = segmenter();
    should(unit.bufferedDurationMs).equal(0);
    unit.push(tone(4));
    should(unit.bufferedDurationMs).be.above(0);
  });

  it('reset drops the abandoned generation and reopens the segmenter', () => {
    const unit = segmenter();
    unit.push(tone(VOICED_FRAMES));
    unit.reset();
    should(unit.bufferedDurationMs).equal(0);

    unit.push(tone(VOICED_FRAMES));
    const segments = unit.push(quiet(PAUSE_FRAMES));
    should(segments).have.length(1);
    // Numbering restarts, so nothing from before the reset can be mistaken for
    // part of the new capture.
    should((segments[0] as SpeechSegment).id).equal(0);
    should((segments[0] as SpeechSegment).startSample).be.below(unit.sampleRate);
  });

  it('trims the idle buffer to the pre-roll while nothing is being said', () => {
    const unit = segmenter();
    unit.push(quiet(500));
    should(unit.bufferedDurationMs).be.below(DEFAULT_SEGMENTER_OPTIONS.preRollMs + DEFAULT_SEGMENTER_OPTIONS.frameMs);
  });

  it('raises its threshold to follow ambient noise instead of chasing the hiss', () => {
    const roomTone = tone(400, 0.005);
    // Loud enough to open an utterance in a silent room, quiet enough that a
    // noisy one should ignore it.
    const marginal = tone(VOICED_FRAMES, 0.0085);

    const silentRoom = segmenter();
    silentRoom.push(marginal);
    should(silentRoom.push(quiet(PAUSE_FRAMES))).have.length(1);

    const noisyRoom = segmenter();
    noisyRoom.push(roomTone);
    noisyRoom.push(marginal);
    should(noisyRoom.push(quiet(PAUSE_FRAMES))).have.length(0);
  });
});

describe('SilenceSegmenter options', () => {
  it('falls back to the documented defaults for anything nonsensical', () => {
    const unit = new SilenceSegmenter({
      sampleRate: Number.NaN,
      frameMs: -1,
      preRollMs: Number.POSITIVE_INFINITY,
      startVoiceMs: 0,
      endSilenceMs: Number.NaN,
      minVoicedMs: -5,
      softMaxMs: Number.NaN,
      softCutSilenceMs: 0,
      speechRms: -1,
      continuingSpeechRms: Number.NaN,
      noiseMultiplier: 0,
    });

    should(unit.sampleRate).equal(16_000);
    should(unit.frameSamples).equal(FRAME);
  });

  it('never lets a frame collapse to zero samples', () => {
    const unit = new SilenceSegmenter({ sampleRate: 8_000, frameMs: 0.0001 });
    should(unit.frameSamples).equal(1);
  });
});
