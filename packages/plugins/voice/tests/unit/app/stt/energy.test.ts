/**
 * Proves the shared loudness math: RMS is total (empty, reversed and out-of-range stretches are 0,
 * never NaN), frames are whole frames only, the floor is the 10th percentile, and the quiet
 * threshold sits between its clamps. `near-live.test.ts` proves the same math through `quietRuns`.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  frameLevels,
  hasSpeech,
  MAX_QUIET_RMS,
  MIN_QUIET_RMS,
  noiseFloor,
  quietThreshold,
  rms,
  SPEECH_RMS,
} from '../../../../app/lib/stt/energy.ts';

const constant = (value: number, length: number): Float32Array => new Float32Array(length).fill(value);

describe('rms', () => {
  it('is the root-mean-square of the stretch', () => {
    should(rms(constant(0.5, 100), 0, 100)).be.approximately(0.5, 1e-6);
    should(rms(Float32Array.of(3, 4), 0, 2)).be.approximately(Math.sqrt(12.5), 1e-6);
    should(rms(Float32Array.of(0, 0, 1, 1), 2, 4)).be.approximately(1, 1e-6);
  });

  it('is 0 for an empty, reversed or fully out-of-range stretch', () => {
    const samples = constant(1, 10);
    should(rms(samples, 3, 3)).equal(0);
    should(rms(samples, 8, 2)).equal(0);
    should(rms(samples, 20, 30)).equal(0);
    should(rms(new Float32Array(0), 0, 0)).equal(0);
  });

  it('clamps a stretch that overhangs the samples to the samples there are', () => {
    should(rms(constant(1, 10), -5, 99)).be.approximately(1, 1e-6);
  });

  it('never returns NaN or Infinity', () => {
    should(rms(Float32Array.of(Number.NaN, 1), 0, 2)).equal(0);
    should(rms(Float32Array.of(Number.POSITIVE_INFINITY), 0, 1)).equal(0);
  });
});

describe('frameLevels', () => {
  it('measures whole frames only', () => {
    const samples = new Float32Array(25);
    samples.fill(1, 10, 20);
    should(frameLevels(samples, 0, 25, 10).map(level => Math.round(level))).eql([0, 1]);
  });

  it('starts at `from` and stops at `to`', () => {
    const samples = new Float32Array(40);
    samples.fill(1, 20, 40);
    should(frameLevels(samples, 20, 40, 10)).eql([1, 1]);
    should(frameLevels(samples, 0, 20, 10)).eql([0, 0]);
  });

  it('has no frames when the stretch is shorter than one, or the frame is not a size', () => {
    should(frameLevels(constant(1, 5), 0, 5, 10)).eql([]);
    should(frameLevels(constant(1, 50), 0, 50, 0)).eql([]);
    should(frameLevels(constant(1, 50), 0, 50, Number.NaN)).eql([]);
  });
});

describe('frameLevels with invalid bounds', () => {
  it('returns no frames, and returns, for non-finite bounds or frame sizes', () => {
    const samples = new Float32Array(320);
    should(frameLevels(samples, -Infinity, 320, 320)).eql([]);
    should(frameLevels(samples, 0, Infinity, 320)).eql([]);
    should(frameLevels(samples, 0, Number.NaN, 320)).eql([]);
    should(frameLevels(samples, Number.NaN, 320, 320)).eql([]);
    should(frameLevels(samples, 0, 320, Infinity)).eql([]);
    should(frameLevels(samples, 0, 320, -Infinity)).eql([]);
    should(frameLevels(samples, 0, 320, -5)).eql([]);
  });

  it('clamps the stretch to the buffer before iterating', () => {
    const samples = new Float32Array(100).fill(1);
    should(frameLevels(samples, -1_000_000, 1_000_000_000, 10)).have.length(10);
    should(frameLevels(samples, 95, 1_000_000_000, 10)).eql([]);
    should(frameLevels(samples, 50, 20, 10)).eql([]);
  });

  it('floors a fractional frame size and rounds the stretch inward', () => {
    const samples = new Float32Array(100).fill(1);
    should(frameLevels(samples, 0.5, 100, 10.9)).have.length(9);
  });
});

describe('noiseFloor', () => {
  it('is the 10th-percentile level', () => {
    const levels = [9, 1, 8, 2, 7, 3, 6, 4, 5, 10];
    should(noiseFloor(levels)).equal(2);
  });

  it('is 0 with nothing heard, and does not reorder its input', () => {
    should(noiseFloor([])).equal(0);
    const levels = [3, 1, 2];
    noiseFloor(levels);
    should(levels).eql([3, 1, 2]);
  });
});

describe('quietThreshold', () => {
  it('is 2.8 times the floor between the clamps', () => {
    should(quietThreshold(0.005)).be.approximately(0.014, 1e-9);
    should(quietThreshold(0)).equal(MIN_QUIET_RMS);
    should(quietThreshold(0.0001)).equal(MIN_QUIET_RMS);
    should(quietThreshold(0.5)).equal(MAX_QUIET_RMS);
  });

  it('takes a different ceiling when asked', () => {
    should(quietThreshold(0.5, 0.03)).equal(0.03);
    should(quietThreshold(0.005, 0.03)).be.approximately(0.014, 1e-9);
  });
});

describe('hasSpeech', () => {
  it('is true just over the speech level and false just under it', () => {
    should(hasSpeech(constant(SPEECH_RMS * 1.01, 100))).be.true();
    should(hasSpeech(constant(SPEECH_RMS / 2, 100))).be.false();
    should(hasSpeech(new Float32Array(0))).be.false();
  });
});
