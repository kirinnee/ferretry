/**
 * WHERE A WHISPER MODEL LIVES ON THIS DEVICE — the runtime-and-model store (`runtime-model-store.ts`)
 * over one Whisper catalog entry and the transformers.js runtime binary the two Whisper models share.
 *
 * What is Whisper's own is the shape `read` hands the worker: the runtime binary, and every model file
 * keyed by the exact pinned URL it was downloaded from. transformers.js asks for a file by that URL
 * (`https://huggingface.co/<repo>/resolve/<commit>/<path>`), so the worker answers each ask from this
 * map and never from the network.
 */

import { modelBundle, runtimeBundle, SPEECH_RUNTIMES, type WhisperCatalogModel } from './model-catalog.ts';
import type { ModelCacheStorage, ModelFetch, ModelStorageManager, PinnedFile } from './model-store.ts';
import { RuntimeModelStore } from './runtime-model-store.ts';

/** What the worker loads: verified bytes. */
export interface WhisperModelBytes {
  /** ONNX Runtime's WebAssembly binary. */
  readonly runtime: Uint8Array;
  /** Every model file, by the pinned URL transformers.js asks for it under. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface WhisperModelStoreOptions {
  readonly model: WhisperCatalogModel;
  /** The build's same-origin URL of the runtime binary. Reading never uses it. */
  readonly runtimeUrl: string;
  readonly caches: ModelCacheStorage | null;
  readonly fetch: ModelFetch;
  readonly storage?: ModelStorageManager | null;
  readonly now?: () => Date;
  readonly partBytes?: number;
  /** Defaults to the pinned runtime binary; tests substitute a byte-exact miniature. */
  readonly runtimeFile?: Omit<PinnedFile, 'url'>;
  /** Whether another installed model still runs on the transformers.js runtime. */
  runtimeInUse(): boolean;
}

export class WhisperModelStore extends RuntimeModelStore {
  readonly #model: WhisperCatalogModel;

  constructor(options: WhisperModelStoreOptions) {
    const { model, runtimeUrl, runtimeFile, ...rest } = options;
    const declared = SPEECH_RUNTIMES['transformers-js'];
    // The transformers.js runtime is declared shared in the catalog, so it always has a bundle.
    const runtime = runtimeBundle(
      runtimeFile === undefined ? declared : { ...declared, file: runtimeFile },
      runtimeUrl,
    ) as NonNullable<ReturnType<typeof runtimeBundle>>;
    super({ ...rest, runtime, model: modelBundle(model) });
    this.#model = model;
  }

  /** The installed model and runtime, verified again, in the shape the worker hands transformers.js. */
  async readModel(): Promise<WhisperModelBytes> {
    const bytes = await this.read();
    const files = new Map<string, Uint8Array>();
    for (const file of this.#model.files) files.set(file.url, bytes.model.get(file.role) ?? new Uint8Array());
    return { runtime: bytes.runtime.get('runtime') ?? new Uint8Array(), files };
  }
}
