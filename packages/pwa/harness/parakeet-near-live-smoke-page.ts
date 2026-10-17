/**
 * The page half of `parakeet-near-live-smoke.ts`: installs Parakeet (or reuses an install), then
 * plays LibriSpeech dev-clean clips (about 31 s) into the shipped near-live transcriber IN REAL
 * TIME through the shipped worker, and measures how far the live words trail the speech. Never part of the app.
 */

import { mixToMono } from '../src/lib/stt/audio-capture.ts';
import { joinWords, type NearLiveState, NearLiveTranscriber, type TimedWord } from '../src/lib/stt/near-live.ts';
import { ParakeetEngine, type ParakeetWorkerLike } from '../src/lib/stt/parakeet-engine.ts';
import { browserParakeetVoice, type ParakeetAssets, type ParakeetGlobalLike } from '../src/lib/stt/parakeet-voice.ts';
import { trustedWorkerUrl } from '../src/lib/trusted-types.ts';

/**
 * LibriSpeech dev-clean samples Hugging Face hosts for exactly this kind of check: three English clips
 * and the first again, about 31 s. (The set's fourth clip is Spanish.)
 */
const CLIPS = [1, 2, 3, 1].map(n => `https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/${n}.flac`);
const RATE = 16_000;
const GAP = new Float32Array(Math.round(0.5 * RATE));
/** `?slowdown=3` makes every live pass take three times as long, to stand in for a phone. */
const SLOWDOWN = Math.max(1, Number(new URLSearchParams(location.search).get('slowdown') ?? '1') || 1);

interface Emission {
  readonly atMs: number;
  readonly state: NearLiveState;
}

interface SmokeWindow {
  __nearLive?: () => Promise<unknown>;
  __violations?: string[];
}

const page = globalThis as unknown as SmokeWindow;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null') as ParakeetAssets;

const concat = (parts: readonly Float32Array[]): Float32Array => {
  const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

const round = (value: number): number => Math.round(value);

page.__nearLive = async () => {
  const voice = browserParakeetVoice(globalThis as unknown as ParakeetGlobalLike, assets);
  await voice.refresh();
  if (voice.getSnapshot().phase !== 'installed') await voice.install();
  if (voice.getSnapshot().phase !== 'installed') throw new Error(`install ended ${voice.getSnapshot().phase}`);

  const clips: Float32Array[] = [];
  for (const url of CLIPS) {
    const flac = await (await fetch(url)).arrayBuffer();
    clips.push(mixToMono(await new OfflineAudioContext(1, RATE, RATE).decodeAudioData(flac)));
  }
  const audio = concat(clips.flatMap(clip => [clip, GAP]));
  const audioMs = (audio.length / RATE) * 1_000;

  const engine = new ParakeetEngine(
    () =>
      new Worker(trustedWorkerUrl(assets.workerUrl), {
        type: 'module',
        name: 'fy-parakeet',
      }) as unknown as ParakeetWorkerLike,
  );
  // Warm the model so the first live pass measures inference, not loading.
  await engine.transcribe(audio.slice(0, RATE));

  // TODAY: one pass over the whole take, after Stop.
  let started = performance.now();
  const single = await engine.transcribe(audio.slice());
  const singleMs = performance.now() - started;
  // Where each word ends in the take, from one timed pass: the yardstick for live-word lag.
  const reference: readonly TimedWord[] = (await engine.transcribeTimed(audio.slice())).words;

  // NEAR-LIVE: the same take, fed in real time.
  const emissions: Emission[] = [];
  const passMs: number[] = [];
  const passLog: { startS: number; seconds: number; words: number; ms: number }[] = [];
  let peeked = 0;
  const t0 = performance.now();
  const recorded = (): Float32Array =>
    audio.subarray(0, Math.min(audio.length, Math.round(((performance.now() - t0) / 1_000) * RATE)));
  const live = new NearLiveTranscriber({
    peek: async () => {
      const now = recorded().slice();
      peeked = now.length;
      return now;
    },
    transcribeTimed: async (samples, signal) => {
      const passStart = performance.now();
      const startS = (peeked - samples.length) / RATE;
      const seconds = samples.length / RATE;
      const heard = await engine.transcribeTimed(samples, signal);
      // A slower device, simulated: wait out the extra time a phone would have spent.
      await new Promise(resolve => setTimeout(resolve, (performance.now() - passStart) * (SLOWDOWN - 1)));
      const ms = performance.now() - passStart;
      passMs.push(ms);
      passLog.push({
        startS: +startS.toFixed(2),
        seconds: +seconds.toFixed(2),
        words: heard.words.length,
        ms: round(ms),
      });
      return heard;
    },
    transcribe: (samples, signal) => engine.transcribe(samples, signal),
    now: () => performance.now(),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: handle => clearTimeout(handle as number),
    onChange: state => emissions.push({ atMs: performance.now() - t0, state }),
  });
  live.start();
  await new Promise(resolve => setTimeout(resolve, audioMs));
  started = performance.now();
  const final = await live.finish(audio.slice());
  const stopToFinalMs = performance.now() - started;

  // Lag: when the Nth live word appeared, minus when the Nth word finished being spoken.
  const lags: number[] = [];
  let shown = 0;
  for (const emission of emissions) {
    const count = joinWords(emission.state.committed, emission.state.interim).split(' ').filter(Boolean).length;
    for (let index = shown; index < count; index += 1) {
      const spoken = reference[index];
      if (spoken !== undefined) lags.push(emission.atMs - spoken.end * 1_000);
    }
    shown = Math.max(shown, count);
  }
  const committedLags: number[] = [];
  let committedShown = 0;
  for (const emission of emissions) {
    const count = emission.state.committed.split(' ').filter(Boolean).length;
    for (let index = committedShown; index < count; index += 1) {
      const spoken = reference[index];
      if (spoken !== undefined) committedLags.push(emission.atMs - spoken.end * 1_000);
    }
    committedShown = Math.max(committedShown, count);
  }

  return {
    audioMs: round(audioMs),
    single: { text: single, ms: round(singleMs) },
    nearLive: {
      final,
      stopToFinalMs: round(stopToFinalMs),
      passes: passMs.length,
      passMs: {
        p50: round(quantile(passMs, 0.5)),
        p95: round(quantile(passMs, 0.95)),
        max: round(Math.max(...passMs)),
      },
      intervalMsAtEnd: live.intervalMs,
      paused: emissions.at(-1)?.state.paused ?? false,
      firstWordAtMs: round(emissions.find(e => e.state.committed + e.state.interim !== '')?.atMs ?? Number.NaN),
      interimLagMs: { p50: round(quantile(lags, 0.5)), p95: round(quantile(lags, 0.95)), words: lags.length },
      committedLagMs: {
        p50: round(quantile(committedLags, 0.5)),
        p95: round(quantile(committedLags, 0.95)),
        words: committedLags.length,
      },
      passLog,
      timeline: emissions.map(e => ({
        at: round(e.atMs),
        committed: e.state.committed.split(' ').filter(Boolean).length,
        interim: e.state.interim,
        paused: e.state.paused,
      })),
    },
  };
};
