/**
 * The page half of `vosk-smoke.ts`: installs Vosk through the shipped store and streams one sample
 * through the shipped worker in recording-sized pieces, the way a dictation feeds it. Bundled by
 * `vosk-smoke.ts`; never part of the app.
 */

import { mixToMono } from '../src/lib/stt/audio-capture.ts';
import { VoskEngine, type VoskHeardState, type VoskWorkerLike } from '../src/lib/stt/vosk-engine.ts';
import { PUMP_MS } from '../src/lib/stt/vosk-session.ts';
import { browserVoskVoice, type VoskAssets, type VoskGlobalLike } from '../src/lib/stt/vosk-voice.ts';
import { trustedWorkerUrl } from '../src/lib/trusted-types.ts';

/** A LibriSpeech sample (dev-clean) Hugging Face hosts for exactly this kind of check. */
const SAMPLE_URL = 'https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/1.flac';

interface SmokeResult {
  readonly text: string;
  readonly heard: readonly VoskHeardState[];
  readonly installMs: number;
  readonly loadMs: number | undefined;
  readonly firstWordsMs: number | null;
  readonly finishMs: number;
}

interface SmokeWindow {
  __smoke?: () => Promise<SmokeResult>;
  /** Bound by `vosk-smoke.ts`: from the moment it resolves, every request is the worker's. */
  __markInstalled?: () => Promise<void>;
  __violations?: string[];
}

const page = globalThis as unknown as SmokeWindow;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null') as VoskAssets;

page.__smoke = async () => {
  const voice = browserVoskVoice(globalThis as unknown as VoskGlobalLike, assets);
  await voice.refresh();
  let started = performance.now();
  await voice.install();
  const installed = voice.getSnapshot();
  if (installed.phase !== 'installed') throw new Error(`install ended ${installed.phase}: ${installed.error?.message}`);
  const installMs = performance.now() - started;

  const flac = await (await fetch(SAMPLE_URL)).arrayBuffer();
  const samples = mixToMono(await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(flac));
  // From here on the page asks for nothing: anything the network sees came from the worker.
  await page.__markInstalled?.();
  const engine = new VoskEngine(
    () =>
      new Worker(trustedWorkerUrl(assets.workerUrl), { type: 'module', name: 'fy-vosk' }) as unknown as VoskWorkerLike,
  );
  const heard: VoskHeardState[] = [];
  let firstWordsAt: number | null = null;
  started = performance.now();
  engine.preload();
  let failure: Error | null = null;
  const stream = engine.open({
    onHeard: state => {
      firstWordsAt ??= performance.now();
      heard.push(state);
    },
    onFailure: error => {
      failure = error;
    },
  });
  // Feed it as a recording would arrive: a pump's worth of audio every pump interval.
  const piece = (16_000 * PUMP_MS) / 1000;
  for (let offset = 0; offset < samples.length; offset += piece) {
    stream.feed(samples.slice(offset, offset + piece));
    await new Promise(resolve => setTimeout(resolve, PUMP_MS));
    if (failure !== null) throw failure;
  }
  const stoppedAt = performance.now();
  const text = await stream.finish();
  return {
    text,
    heard,
    installMs,
    loadMs: engine.consumeLoadMs(),
    firstWordsMs: firstWordsAt === null ? null : firstWordsAt - started,
    finishMs: performance.now() - stoppedAt,
  };
};
