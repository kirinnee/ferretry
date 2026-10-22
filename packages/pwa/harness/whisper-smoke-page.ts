/**
 * The page half of `whisper-smoke.ts`: installs one Whisper model through the shipped store and
 * transcribes one sample through the shipped worker, twice (the first pays the model load). Bundled by
 * `whisper-smoke.ts`; never part of the app.
 */

import { mixToMono } from '../src/lib/stt/audio-capture.ts';
import { onDeviceModel, type WhisperCatalogModel } from '../src/lib/stt/model-catalog.ts';
import { WhisperEngine, type WhisperWorkerLike } from '../src/lib/stt/whisper-engine.ts';
import { browserWhisperVoice, type WhisperAssets, type WhisperGlobalLike } from '../src/lib/stt/whisper-voice.ts';
import { trustedWorkerUrl } from '../src/lib/trusted-types.ts';

/** A LibriSpeech sample (dev-clean) Hugging Face hosts for exactly this kind of check. */
const SAMPLE_URL = 'https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/1.flac';

interface SmokeResult {
  readonly text: string;
  readonly backend: string;
  readonly installMs: number;
  readonly audioMs: number;
  readonly firstMs: number;
  readonly secondMs: number;
  readonly gpu: boolean;
}

interface SmokeWindow {
  __smoke?: (modelId: string) => Promise<SmokeResult>;
  __violations?: string[];
  __installed?: boolean;
  /** Set once installed; the harness calls it after reading memory, and the decodes start. */
  __go?: () => void;
}

const page = globalThis as unknown as SmokeWindow;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null') as WhisperAssets;

page.__smoke = async modelId => {
  const model = onDeviceModel(modelId) as WhisperCatalogModel;
  const voice = browserWhisperVoice(globalThis as unknown as WhisperGlobalLike, assets, model, () => false);
  await voice.refresh();
  let started = performance.now();
  await voice.install();
  const installed = voice.getSnapshot();
  if (installed.phase !== 'installed') throw new Error(`install ended ${installed.phase}: ${installed.error?.message}`);
  const installMs = performance.now() - started;

  const flac = await (await fetch(SAMPLE_URL)).arrayBuffer();
  const samples = mixToMono(await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(flac));
  // From here on nothing but this page's own server may be asked for anything.
  page.__installed = true;
  await new Promise<void>(resolve => {
    page.__go = resolve;
  });
  const engine = new WhisperEngine(
    model.id,
    () =>
      new Worker(trustedWorkerUrl(assets.workerUrl), {
        type: 'module',
        name: `fy-${model.id}`,
      }) as unknown as WhisperWorkerLike,
  );
  started = performance.now();
  const first = await engine.transcribe(samples.slice());
  const firstMs = performance.now() - started;
  started = performance.now();
  await engine.transcribe(samples.slice());
  const secondMs = performance.now() - started;
  const gpu = (await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter()) != null;
  return {
    text: first.text,
    backend: first.backend,
    installMs,
    audioMs: (samples.length / 16_000) * 1000,
    firstMs,
    secondMs,
    gpu,
  };
};
