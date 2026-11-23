/**
 * ONE MODEL AND THE RUNTIME IT SHARES, INSTALLED AS ONE — the store a voice holds when its model runs
 * on a runtime other models use too (`SpeechRuntime.shared`, `model-catalog.ts`).
 *
 * Two pinned bundles (`model-store.ts`), each in its own cache: the runtime's binary, kept once however
 * many models use it, and the model's own files. To the person they are one thing — one Install, one
 * progress bar, one Remove — so this store answers for both:
 *
 *   - INSTALL downloads (or resumes) the runtime first, then the model, as one stream of progress. A
 *     runtime another model already installed costs nothing: its files are complete and are skipped.
 *   - STATUS is the model's: a model nobody installed is `absent` even while its runtime is on the
 *     device for another model, so Settings never offers to "resume" a download nobody started. It is
 *     `installed` only when both bundles are, and `partial` while either has bytes still to come.
 *   - REMOVE deletes the model, and the runtime only when no other installed model still runs on it
 *     (the registry answers, `OnDeviceVoices.runtimeInUse`).
 *   - READ returns both bundles' bytes, each verified again on the way out.
 */

import {
  DownloadSlots,
  type ModelCacheStorage,
  type ModelFetch,
  type ModelInstaller,
  type ModelInstallOptions,
  type ModelStorageManager,
  type ModelStoreStatus,
  type PinnedBundle,
  PinnedModelStore,
} from './model-store.ts';

export interface RuntimeModelStoreOptions {
  readonly runtime: PinnedBundle;
  readonly model: PinnedBundle;
  /** `null` where the browser has no Cache Storage (an insecure page, some private windows). */
  readonly caches: ModelCacheStorage | null;
  readonly fetch: ModelFetch;
  readonly storage?: ModelStorageManager | null;
  readonly now?: () => Date;
  /** Tests use tiny parts over tiny files. */
  readonly partBytes?: number;
  /** Whether another installed model still runs on this runtime, so Remove must keep its binary. */
  runtimeInUse(): boolean;
}

/** Both bundles' verified bytes, by role. */
export interface RuntimeModelBytes {
  readonly runtime: ReadonlyMap<string, Uint8Array>;
  readonly model: ReadonlyMap<string, Uint8Array>;
}

export class RuntimeModelStore implements ModelInstaller {
  readonly #runtime: PinnedModelStore;
  readonly #model: PinnedModelStore;
  readonly #runtimeInUse: () => boolean;

  constructor(options: RuntimeModelStoreOptions) {
    const shared = {
      caches: options.caches,
      fetch: options.fetch,
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
    };
    // ONE budget for the whole install: the runtime's file and the model's files draw from the same three slots.
    const slots = new DownloadSlots();
    this.#runtime = new PinnedModelStore({ ...shared, slots, bundle: options.runtime });
    this.#model = new PinnedModelStore({ ...shared, slots, bundle: options.model });
    this.#runtimeInUse = () => options.runtimeInUse();
  }

  /** Every byte a device with neither bundle downloads. */
  get totalBytes(): number {
    return this.#runtime.totalBytes + this.#model.totalBytes;
  }

  async status(): Promise<ModelStoreStatus> {
    const [model, runtime] = await Promise.all([this.#model.status(), this.#runtime.status()]);
    if (model.state === 'absent') return { state: 'absent' };
    if (model.state === 'installed' && runtime.state === 'installed')
      return { ...model, bytes: model.bytes + runtime.bytes };
    const stored = (status: ModelStoreStatus): number =>
      status.state === 'installed' ? status.bytes : status.state === 'partial' ? status.downloadedBytes : 0;
    return { state: 'partial', downloadedBytes: stored(model) + stored(runtime) };
  }

  /**
   * Download (or resume) the runtime and the model side by side, as one progress stream. They are separate bundles with
   * separate caches, so neither waits for the other; one failing stops the other (what it finished is kept) and its error is thrown.
   */
  async install(options: ModelInstallOptions = {}): Promise<void> {
    const total = this.totalBytes;
    const { signal, onProgress } = options;
    const stop = new AbortController();
    const relay = (): void => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const done = { runtime: 0, model: 0 };
    const labels = { runtime: '', model: '' };
    const part = (which: 'runtime' | 'model', store: PinnedModelStore): Promise<void> =>
      store.install({
        signal: stop.signal,
        onProgress: progress => {
          done[which] = progress.downloadedBytes;
          labels[which] = progress.label;
          // The model is what the person is waiting for: its file is named until it is whole, then the runtime's.
          const label = done.model < this.#model.totalBytes ? labels.model || progress.label : progress.label;
          onProgress?.({ label, downloadedBytes: done.runtime + done.model, totalBytes: total });
        },
      });
    let failure: { readonly error: unknown } | null = null;
    const guard = (run: Promise<void>): Promise<void> =>
      run.catch((error: unknown) => {
        failure ??= { error };
        stop.abort();
      });
    try {
      await Promise.all([guard(part('runtime', this.#runtime)), guard(part('model', this.#model))]);
    } finally {
      signal?.removeEventListener('abort', relay);
    }
    if (failure !== null) throw (failure as { readonly error: unknown }).error;
  }

  /** Delete the model, and the runtime too when nothing else installed runs on it. */
  async remove(): Promise<void> {
    await this.#model.remove();
    if (!this.#runtimeInUse()) await this.#runtime.remove();
  }

  /** Both bundles, every file verified again. */
  async read(): Promise<RuntimeModelBytes> {
    return { runtime: await this.#runtime.read(), model: await this.#model.read() };
  }
}
