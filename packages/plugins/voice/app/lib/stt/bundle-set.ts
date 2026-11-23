/**
 * A MODEL AND THE RUNTIME IT RUNS ON, INSTALLED AS ONE — what the person sees as "Install Moonshine"
 * when the runtime's binary is a separate bundle several models share (`model-catalog.ts`).
 *
 * Status is the conjunction: installed only when every part is. Install fetches the parts side by side,
 * skipping a part that is already installed — the shared runtime arrives with the FIRST model on it
 * and is never fetched twice — and reports one progress across them. Remove deletes the model's own
 * bundle always, and the shared runtime only when no other installed model still needs it.
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

interface BundleSetPart {
  readonly installer: ModelInstaller;
  /** True for the runtime bundle other models share. */
  readonly shared: boolean;
}

export interface BundleSetOptions {
  /** In install order: the shared runtime first, the model last (its version is the set's). */
  readonly parts: readonly BundleSetPart[];
  /** Asked on remove: whether another installed model still runs on the shared parts. */
  sharedStillNeeded(): boolean;
}

export class BundleSetInstaller implements ModelInstaller {
  readonly #options: BundleSetOptions;

  constructor(options: BundleSetOptions) {
    this.#options = options;
  }

  get totalBytes(): number {
    return this.#options.parts.reduce((total, part) => total + part.installer.totalBytes, 0);
  }

  async status(): Promise<ModelStoreStatus> {
    const parts = this.#options.parts;
    const states = await Promise.all(parts.map(part => part.installer.status()));
    const stored = (state: ModelStoreStatus): number =>
      state.state === 'installed' ? state.bytes : state.state === 'partial' ? state.downloadedBytes : 0;
    const last = states.at(-1);
    if (last?.state === 'installed' && states.every(state => state.state === 'installed')) {
      const installedAt = states.reduce(
        (latest, state) => (state.state === 'installed' && state.installedAt > latest ? state.installedAt : latest),
        '',
      );
      return { state: 'installed', version: last.version, bytes: this.totalBytes, installedAt };
    }
    // A shared runtime another model installed is not progress on THIS model: it stays "absent".
    const own = states.reduce((total, state, index) => total + (parts[index]?.shared === true ? 0 : stored(state)), 0);
    const downloaded = states.reduce((total, state) => total + stored(state), 0);
    return own > 0 ? { state: 'partial', downloadedBytes: downloaded } : { state: 'absent' };
  }

  /**
   * Download every part that is not installed yet side by side, as one progress stream: a part never waits for another
   * (the shared runtime and the model are separate bundles with separate caches), and the stores they are made of share
   * one download budget, so "side by side" never means more files than that budget allows. One failing stops the rest
   * (what they finished is kept, so Install resumes) and its error is the one thrown; a cancel stops them all.
   */
  async install(options: ModelInstallOptions = {}): Promise<void> {
    const parts = this.#options.parts;
    const total = this.totalBytes;
    const { signal, onProgress } = options;
    const held = await Promise.all(parts.map(async part => (await part.installer.status()).state === 'installed'));
    const stored = parts.map((part, index) => (held[index] === true ? part.installer.totalBytes : 0));
    const labels = parts.map(() => '');
    const report = (label: string): void =>
      onProgress?.({ label, downloadedBytes: stored.reduce((sum, bytes) => sum + bytes, 0), totalBytes: total });
    // A part already installed is reported at once.
    if (held.some(Boolean)) report('Speech runtime');
    const stop = new AbortController();
    const relay = (): void => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener('abort', relay, { once: true });
    let failure: { readonly error: unknown } | null = null;
    const run = async (part: BundleSetPart, index: number): Promise<void> => {
      try {
        await part.installer.install({
          signal: stop.signal,
          onProgress: progress => {
            stored[index] = progress.downloadedBytes;
            labels[index] = progress.label;
            // The model (last) is what the person waits for: its file is named until it is whole, then the earlier parts'.
            const open = parts.findLastIndex(
              (other, at) => (stored[at] ?? 0) < other.installer.totalBytes && labels[at] !== '',
            );
            report(open === -1 ? progress.label : (labels[open] ?? progress.label));
          },
        });
        stored[index] = part.installer.totalBytes;
      } catch (error) {
        failure ??= { error };
        stop.abort();
      }
    };
    try {
      await Promise.all(parts.flatMap((part, index) => (held[index] === true ? [] : [run(part, index)])));
    } finally {
      signal?.removeEventListener('abort', relay);
    }
    if (failure !== null) throw (failure as { readonly error: unknown }).error;
  }

  async remove(): Promise<void> {
    const keepShared = this.#options.sharedStillNeeded();
    for (const part of this.#options.parts) {
      if (part.shared && keepShared) continue;
      await part.installer.remove();
    }
  }
}

/** What the install of a model and its runtime reaches the device through. */
export interface RuntimeAndModelEnvironment {
  readonly caches: ModelCacheStorage | null;
  readonly fetch: ModelFetch;
  readonly storage: ModelStorageManager | null;
}

/**
 * The install of one model on a shared runtime, as the sherpa voices build it (`sherpa-voice.ts`): the runtime's pinned
 * bundle and the model's own, downloading side by side out of ONE budget of three files.
 */
export function runtimeAndModelInstaller(
  runtime: PinnedBundle,
  model: PinnedBundle,
  environment: RuntimeAndModelEnvironment,
  sharedStillNeeded: () => boolean,
): ModelInstaller {
  const slots = new DownloadSlots();
  return new BundleSetInstaller({
    parts: [
      { installer: new PinnedModelStore({ ...environment, slots, bundle: runtime }), shared: true },
      { installer: new PinnedModelStore({ ...environment, slots, bundle: model }), shared: false },
    ],
    sharedStillNeeded,
  });
}
