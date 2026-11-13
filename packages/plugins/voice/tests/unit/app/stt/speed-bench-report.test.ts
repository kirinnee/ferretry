/**
 * Proves the benchmark's data and arithmetic (`lib/stt/speed-bench-report.ts`): the result schema can hold timings and
 * nothing else, and the figures the docs quote are computed one way.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  afterPause,
  isSoftwareAdapter,
  median,
  parseSpeedBenchReport,
  realTimeFactor,
  round1,
  SPEED_BENCH_VERSION,
  syntheticClip,
  userAgentFamily,
} from '../../../../app/lib/stt/speed-bench-report.ts';

const DEVICE = {
  userAgentFamily: 'Chrome',
  crossOriginIsolated: false,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  webgpuAdapter: false,
  webgpuAdapterClass: null,
  webgpuAdapterIsSoftware: null,
};
const RUN = {
  engine: 'parakeet',
  path: 'wasm-single',
  threads: 1,
  loadMs: 5_000,
  decodeMs: [4_000, 4_100, 3_900],
  realTimeFactor: 0.8,
  lastAudioToTextMs: 4_000,
  afterEarlyFinishMs: 2_500,
  fellBack: false,
  failure: null,
};
const REPORT = { v: SPEED_BENCH_VERSION, clipSeconds: 5, pauseMs: 1_500, device: DEVICE, runs: [RUN] };

describe('parseSpeedBenchReport', () => {
  it('accepts a well-formed result', () => {
    should(parseSpeedBenchReport(REPORT)).deepEqual(REPORT);
  });

  it('can hold no transcript: a text field, or any extra field, is refused', () => {
    should(parseSpeedBenchReport({ ...REPORT, runs: [{ ...RUN, text: 'please fix the login redirect' }] })).equal(null);
    should(parseSpeedBenchReport({ ...REPORT, transcript: 'hello' })).equal(null);
    should(parseSpeedBenchReport({ ...REPORT, device: { ...DEVICE, ip: '10.0.0.2' } })).equal(null);
  });

  it('holds a failure only as a short code, never a message', () => {
    should(parseSpeedBenchReport({ ...REPORT, runs: [{ ...RUN, failure: 'load-failed' }] })).not.equal(null);
    should(
      parseSpeedBenchReport({ ...REPORT, runs: [{ ...RUN, failure: 'The model could not load: hello world' }] }),
    ).equal(null);
  });

  it('refuses other versions, junk and negative times', () => {
    should(parseSpeedBenchReport({ ...REPORT, v: 2 })).equal(null);
    should(parseSpeedBenchReport(null)).equal(null);
    should(parseSpeedBenchReport('x')).equal(null);
    should(parseSpeedBenchReport({ ...REPORT, runs: [{ ...RUN, loadMs: -1 }] })).equal(null);
    should(parseSpeedBenchReport({ ...REPORT, runs: [{ ...RUN, engine: 'gpt' }] })).equal(null);
  });
});

describe('the arithmetic', () => {
  it('takes the median of odd, even, empty and messy lists', () => {
    should(median([3, 1, 2])).equal(2);
    should(median([4, 1, 2, 3])).equal(2.5);
    should(median([])).equal(null);
    should(median([Number.NaN, 5])).equal(5);
  });

  it('is decode time over audio time', () => {
    should(realTimeFactor([2_500, 2_500, 2_500], 5)).equal(0.5);
    should(realTimeFactor([], 5)).equal(null);
    should(realTimeFactor([1_000], 0)).equal(null);
  });

  it('leaves what is left of a decode after the pause, never negative', () => {
    should(afterPause(4_000, 1_500)).equal(2_500);
    should(afterPause(900, 1_500)).equal(0);
    should(afterPause(900, -5)).equal(900);
  });

  it('rounds to one decimal', () => {
    should(round1(2.449)).equal(2.4);
    should(round1(2.45)).equal(2.5);
  });

  it('names a browser family without its version', () => {
    should(userAgentFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36')).equal(
      'Chrome',
    );
    should(
      userAgentFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605 Version/18.0 Mobile Safari/604.1'),
    ).equal('Safari (mobile)');
    should(userAgentFamily('Mozilla/5.0 (Android 15) Chrome/150 Mobile Safari/537.36')).equal('Chrome (mobile)');
    should(userAgentFamily('curl/8')).equal('Other');
  });

  it('knows a software GPU from a real one', () => {
    should(isSoftwareAdapter('Google SwiftShader')).equal(true);
    should(isSoftwareAdapter('llvmpipe (LLVM 15)')).equal(true);
    should(isSoftwareAdapter('NVIDIA Ampere')).equal(false);
  });
});

describe('syntheticClip', () => {
  it('is exactly as long as asked, quiet at the end, and the same every time', () => {
    const clip = syntheticClip(5);
    should(clip.length).equal(80_000);
    should(syntheticClip(5)).deepEqual(clip);
    should(Math.max(...clip.slice(-1_000).map(Math.abs))).equal(0);
    should(Math.max(...clip.map(Math.abs))).be.above(0.05);
  });
});
