import { STT_SAMPLE_RATE, type SttWorkerModel } from '@ferretry/protocol';
import { lstat } from 'node:fs/promises';
import type { SttRecognizer, SttRecognizerFactory } from './worker-runtime.ts';

/** The environment variable that repoints the recognizer at another module. */
export const RECOGNIZER_MODULE_VARIABLE = 'FY_STT_RECOGNIZER_MODULE';
export const DEFAULT_RECOGNIZER_MODULE = 'sherpa-onnx-node';
const FEATURE_DIMENSION = 80;

interface OfflineStreamLike {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decode(stream: OfflineStreamLike): void;
  getResult(stream: OfflineStreamLike): { text?: unknown };
}

interface SherpaModuleLike {
  OfflineRecognizer?: new (config: unknown) => OfflineRecognizerLike;
}

export type ModuleLoader = (specifier: string) => Promise<unknown>;

/** Wraps one sherpa offline recognizer as a single synchronous transcribe call. */
class SherpaRecognizer implements SttRecognizer {
  constructor(private readonly recognizer: OfflineRecognizerLike) {}

  transcribe(samples: Float32Array, sampleRate: number): string {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    this.recognizer.decode(stream);
    const result = this.recognizer.getResult(stream);
    return typeof result.text === 'string' ? result.text : '';
  }
}

/**
 * Loads the native recognizer.
 *
 * The addon is optional: a host without it still runs the daemon, and a load
 * attempt fails with a message the domain classifies as `native_missing` rather
 * than crashing the worker. The module specifier is configurable so a host can
 * point at its own build — and so an integration test can prove the whole IPC
 * path without the 600 MB weights or the native library.
 */
export class SherpaRecognizerFactory implements SttRecognizerFactory {
  constructor(
    private readonly specifier: string = DEFAULT_RECOGNIZER_MODULE,
    private readonly load: ModuleLoader = specifier => import(specifier),
  ) {}

  async create(model: SttWorkerModel, threads: number): Promise<SttRecognizer> {
    await assertModelFiles(model);
    const namespace = (await this.load(this.specifier)) as { default?: SherpaModuleLike } & SherpaModuleLike;
    const sherpa = namespace.default ?? namespace;
    if (typeof sherpa.OfflineRecognizer !== 'function') {
      throw new Error(`${this.specifier} does not export OfflineRecognizer`);
    }
    return new SherpaRecognizer(
      new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: FEATURE_DIMENSION },
        modelConfig: {
          transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
          tokens: model.tokens,
          numThreads: threads,
          provider: 'cpu',
          modelType: 'nemo_transducer',
        },
        decodingMethod: 'greedy_search',
      }),
    );
  }
}

/** Every artifact must be a regular file: a symlink could point anywhere. */
async function assertModelFiles(model: SttWorkerModel): Promise<void> {
  for (const file of [model.encoder, model.decoder, model.joiner, model.tokens]) {
    const info = await lstat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`model file is not a regular file: ${file}`);
  }
}

export function recognizerModuleFrom(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = environment[RECOGNIZER_MODULE_VARIABLE]?.trim();
  return configured === undefined || configured.length === 0 ? DEFAULT_RECOGNIZER_MODULE : configured;
}
