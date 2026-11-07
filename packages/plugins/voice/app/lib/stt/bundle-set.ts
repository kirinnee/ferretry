/**
 * A MODEL AND THE RUNTIME IT RUNS ON, INSTALLED AS ONE — what the person sees as "Install Moonshine"
 * when the runtime's binary is a separate bundle several models share (`model-catalog.ts`).
 *
 * Status is the conjunction: installed only when every part is. Install fetches the parts in order,
 * skipping a part that is already installed — the shared runtime arrives with the FIRST model on it
 * and is never fetched twice — and reports one progress across them. Remove deletes the model's own
 * bundle always, and the shared runtime only when no other installed model still needs it.
 */

import type { ModelInstaller, ModelInstallOptions, ModelStoreStatus } from './model-store.ts';

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

  async install(options: ModelInstallOptions = {}): Promise<void> {
    const total = this.totalBytes;
    let before = 0;
    for (const part of this.#options.parts) {
      const size = part.installer.totalBytes;
      if ((await part.installer.status()).state === 'installed') {
        before += size;
        options.onProgress?.({ label: 'Speech runtime', downloadedBytes: before, totalBytes: total });
        continue;
      }
      const offset = before;
      await part.installer.install({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onProgress: progress =>
          options.onProgress?.({
            label: progress.label,
            downloadedBytes: offset + progress.downloadedBytes,
            totalBytes: total,
          }),
      });
      before += size;
    }
  }

  async remove(): Promise<void> {
    const keepShared = this.#options.sharedStillNeeded();
    for (const part of this.#options.parts) {
      if (part.shared && keepShared) continue;
      await part.installer.remove();
    }
  }
}
