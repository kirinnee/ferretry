/**
 * The page half of `parakeet-smoke.ts`: installs Parakeet through the shipped store and transcribes
 * one sample through the shipped worker. Bundled by `parakeet-smoke.ts`; never part of the app.
 */

import { mixToMono } from '../src/lib/stt/audio-capture.ts';
import { ParakeetEngine, type ParakeetWorkerLike } from '../src/lib/stt/parakeet-engine.ts';
import { browserParakeetVoice, type ParakeetAssets, type ParakeetGlobalLike } from '../src/lib/stt/parakeet-voice.ts';
import { trustedWorkerUrl } from '../src/lib/trusted-types.ts';

/** A LibriSpeech sample (dev-clean) Hugging Face hosts for exactly this kind of check. */
const SAMPLE_URL = 'https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/1.flac';

interface SmokeWindow {
  __smoke?: () => Promise<{ readonly text: string; readonly installMs: number; readonly transcribeMs: number }>;
  __violations?: string[];
}

const page = globalThis as unknown as SmokeWindow;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null') as ParakeetAssets;

page.__smoke = async () => {
  const voice = browserParakeetVoice(globalThis as unknown as ParakeetGlobalLike, assets);
  await voice.refresh();
  let started = performance.now();
  await voice.install();
  const installed = voice.getSnapshot();
  if (installed.phase !== 'installed') throw new Error(`install ended ${installed.phase}: ${installed.error?.message}`);
  const installMs = performance.now() - started;

  const flac = await (await fetch(SAMPLE_URL)).arrayBuffer();
  const samples = mixToMono(await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(flac));
  const engine = new ParakeetEngine(
    () =>
      new Worker(trustedWorkerUrl(assets.workerUrl), {
        type: 'module',
        name: 'fy-parakeet',
      }) as unknown as ParakeetWorkerLike,
  );
  started = performance.now();
  const text = await engine.transcribe(samples);
  return { text, installMs, transcribeMs: performance.now() - started };
};
