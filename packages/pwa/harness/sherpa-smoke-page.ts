/**
 * The page half of `sherpa-smoke.ts`: installs a sherpa model (and the shared runtime) through the
 * shipped stores and streams one sample through the shipped worker. Bundled by `sherpa-smoke.ts`;
 * never part of the app.
 */

import { mixToMono } from '../src/lib/stt/audio-capture.ts';
import { onDeviceModel } from '../src/lib/stt/model-catalog.ts';
import { SherpaEngine, type StreamWords } from '../src/lib/stt/sherpa-engine.ts';
import { browserSherpaVoice, type SherpaAssets, type SherpaGlobalLike } from '../src/lib/stt/sherpa-voice.ts';
import { trustedWorkerUrl } from '../src/lib/trusted-types.ts';

/** A LibriSpeech sample (dev-clean) Hugging Face hosts for exactly this kind of check. */
const SAMPLE_URL = 'https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/1.flac';
/** A quarter-second of 16 kHz audio: what the streaming session pushes per read. */
const SLICE = 4_000;

interface SmokeResult {
  readonly text: string;
  readonly partials: number;
  readonly firstWordsAfterMs: number | null;
  readonly installMs: number;
  readonly loadMs: number | undefined;
  readonly streamMs: number;
  readonly closeMs: number;
  readonly audioMs: number;
}

interface SmokeWindow {
  __smoke?: () => Promise<SmokeResult>;
  __violations?: string[];
}

const page = globalThis as unknown as SmokeWindow;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null') as SherpaAssets & {
  readonly model: string;
};

page.__smoke = async () => {
  const model = onDeviceModel(assets.model);
  if (model?.runtime !== 'sherpa-onnx') throw new Error(`${assets.model} is not a sherpa model`);
  const voice = browserSherpaVoice(model, globalThis as unknown as SherpaGlobalLike, assets, () => false);
  await voice.refresh();
  let started = performance.now();
  await voice.install();
  const installed = voice.getSnapshot();
  if (installed.phase !== 'installed') throw new Error(`install ended ${installed.phase}: ${installed.error?.message}`);
  const installMs = performance.now() - started;

  const flac = await (await fetch(SAMPLE_URL)).arrayBuffer();
  const samples = mixToMono(await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(flac));
  const engine = new SherpaEngine(
    () => new Worker(trustedWorkerUrl(assets.workerUrl), { type: 'module', name: `fy-${model.id}` }),
    model.id,
  );
  const seen: StreamWords[] = [];
  let failure: unknown = null;
  let firstWordsAt: number | null = null;
  const stream = engine.openStream({
    onPartial: words => {
      seen.push(words);
      if (firstWordsAt === null && `${words.committed}${words.interim}`.trim() !== '') firstWordsAt = performance.now();
    },
    onFailure: error => {
      failure = error;
    },
  });
  started = performance.now();
  // Real time: one slice every 250 ms, as a person speaking would produce them.
  for (let offset = 0; offset < samples.length; offset += SLICE) {
    stream.push(samples.slice(offset, offset + SLICE));
    await new Promise(done => setTimeout(done, 250));
  }
  const streamMs = performance.now() - started;
  const closing = performance.now();
  const text = await stream.close();
  if (failure !== null) throw failure;
  return {
    text,
    partials: seen.length,
    firstWordsAfterMs: firstWordsAt === null ? null : firstWordsAt - started,
    installMs,
    loadMs: engine.consumeLoadMs(),
    streamMs,
    closeMs: performance.now() - closing,
    audioMs: (samples.length / 16_000) * 1000,
  };
};
