/**
 * WHERE THE PARAKEET MODEL LIVES ON THIS DEVICE — the pinned store (`model-store.ts`) over Parakeet's
 * one bundle: its three model files and the ONNX Runtime binary, in the `fy-stt-parakeet-v1` cache
 * under `/fy-stt/parakeet`, exactly where every Parakeet install before the model catalog put them.
 *
 * All of the download, resume, verify and remove rules are the generic store's. What is Parakeet's
 * own is the shape `read` hands the worker: named bytes and the vocabulary as text.
 */

import {
  MODEL_PART_BYTES,
  type ModelCacheLike,
  type ModelCacheStorage,
  type ModelFetch,
  ModelInstallError,
  type ModelInstallOptions,
  type ModelInstallProgress,
  type ModelStorageManager,
  type ModelStoreStatus,
  PinnedModelStore,
} from './model-store.ts';
import { PARAKEET_CACHE, PARAKEET_VERSION_LABEL, type ParakeetFile, parakeetFiles } from './parakeet-model.ts';

export const PARAKEET_PART_BYTES = MODEL_PART_BYTES;

/** Parakeet's names for the generic store's types, kept for the code that already spells them. */
export type ParakeetCacheLike = ModelCacheLike;
export type ParakeetCacheStorage = ModelCacheStorage;
export type ParakeetStorageManager = ModelStorageManager;
export type ParakeetFetch = ModelFetch;
export type ParakeetInstallProgress = ModelInstallProgress;
export type ParakeetStoreStatus = ModelStoreStatus;
export { ModelInstallError as ParakeetInstallError };

/** What the worker loads: verified bytes and the vocabulary text. */
export interface ParakeetModelBytes {
  readonly runtime: Uint8Array;
  readonly encoder: Uint8Array;
  readonly decoder: Uint8Array;
  readonly vocabulary: string;
}

export interface ParakeetModelStoreOptions {
  /** `null` where the browser has no Cache Storage (an insecure page, some private windows). */
  readonly caches: ParakeetCacheStorage | null;
  readonly fetch: ParakeetFetch;
  /** The build's same-origin URL of the ONNX Runtime binary. */
  readonly runtimeUrl: string;
  readonly storage?: ParakeetStorageManager | null;
  readonly now?: () => Date;
  /** Defaults to {@link PARAKEET_PART_BYTES}; tests use tiny parts over tiny files. */
  readonly partBytes?: number;
  /** Defaults to the pinned files; tests substitute byte-exact miniatures. */
  readonly files?: readonly ParakeetFile[];
}

export class ParakeetModelStore {
  readonly #store: PinnedModelStore;

  constructor(options: ParakeetModelStoreOptions) {
    this.#store = new PinnedModelStore({
      bundle: {
        name: 'Parakeet',
        cache: PARAKEET_CACHE,
        keyRoot: '/fy-stt/parakeet',
        versionLabel: PARAKEET_VERSION_LABEL,
        files: options.files ?? parakeetFiles(options.runtimeUrl),
      },
      caches: options.caches,
      fetch: options.fetch,
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
    });
  }

  /** Every byte a complete install holds. */
  get totalBytes(): number {
    return this.#store.totalBytes;
  }

  status(): Promise<ParakeetStoreStatus> {
    return this.#store.status();
  }

  /** Download (or resume) every missing file; see {@link PinnedModelStore.install}. */
  install(options: ModelInstallOptions = {}): Promise<void> {
    return this.#store.install(options);
  }

  /** Delete every stored byte, finished or not. */
  remove(): Promise<void> {
    return this.#store.remove();
  }

  /** Read the installed model back, verifying every file again. */
  async read(): Promise<ParakeetModelBytes> {
    const bytes = await this.#store.read();
    const take = (role: string): Uint8Array => bytes.get(role) ?? new Uint8Array();
    return {
      runtime: take('runtime'),
      encoder: take('encoder'),
      decoder: take('decoder'),
      vocabulary: new TextDecoder().decode(take('vocabulary')),
    };
  }
}

/** For copy that names the download before anything is fetched. */
export { PARAKEET_DOWNLOAD_SIZE } from './parakeet-model.ts';
