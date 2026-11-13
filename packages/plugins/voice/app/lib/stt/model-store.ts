/**
 * WHERE AN ON-DEVICE SPEECH BUNDLE LIVES ON THIS DEVICE: download once, verify, keep, read back, remove.
 *
 * A BUNDLE is a set of pinned files that are installed and removed together — one speech model's
 * files, or one runtime's binary that several models share (`model-catalog.ts`). Each bundle has its
 * own Cache Storage cache, so removing one is deleting one cache, and nothing a bundle stores can be
 * mistaken for another's.
 *
 * EXPLICIT. Nothing here runs on its own. `install` is called from a button the person presses after
 * reading what it costs; dictation never downloads anything (`read` refuses a missing bundle instead).
 *
 * STORED IN PARTS, so it can be cancelled and resumed. Every file is cut into 32 MiB parts, each its
 * own Cache Storage entry, and after every part the store writes a small progress record holding the
 * SHA-256 state so far (`sha256.ts`). A cancelled, crashed or offline download therefore resumes with
 * an HTTP `Range` request from the first byte it does not have, and keeps hashing exactly where it
 * stopped. Hugging Face and its CDN answer ranges with `206`; a server that ignores one and answers
 * `200` restarts that file from zero rather than being trusted to line up.
 *
 * VERIFIED TWICE. A file is only marked complete when its bytes hash to the pinned value; a mismatch
 * deletes every part of it. `read` hashes again on the way out, because any script on this origin can
 * write Cache Storage and a runtime is code: a bundle that changed on disk since it was installed is
 * refused, not loaded.
 *
 * NEVER BUFFERED WHOLE ON INSTALL. Peak memory while downloading is one part.
 *
 * Generalised from the Parakeet store, which is now this class over Parakeet's bundle
 * (`parakeet-store.ts`) with the same cache name and keys, so a Parakeet install made before the
 * catalog existed is still recognised.
 */

import { isSha256State, Sha256, type Sha256State } from './sha256.ts';

/** 32 MiB: a multiple of the 64-byte hash block, small enough to hold, large enough to be few. */
export const MODEL_PART_BYTES = 32 * 1024 * 1024;

/** Decimal megabytes, the unit storage settings on phones and browsers report. */
export const formatMegabytes = (bytes: number): string => `${Math.max(0, Math.round(bytes / 1_000_000))} MB`;

/** One pinned file: where it comes from, and exactly which bytes it must be. */
export interface PinnedFile {
  /** What the bundle calls it (`encoder`, `tokens`, `runtime`…); unique within the bundle. */
  readonly role: string;
  /** Shown while it downloads. */
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  /** Lowercase hex. */
  readonly sha256: string;
}

/** Files installed and removed together, under their own cache. */
export interface PinnedBundle {
  /** Named in sentences: "Moonshine Tiny is not installed on this device." */
  readonly name: string;
  /** The Cache Storage cache. Never prefixed like the signed release's caches, so its pruning never touches it. */
  readonly cache: string;
  /** Prefix of every key in the cache. */
  readonly keyRoot: string;
  /** What Settings shows as the installed version. */
  readonly versionLabel: string;
  readonly files: readonly PinnedFile[];
}

export interface ModelCacheLike {
  put(key: string, response: Response): Promise<void>;
  match(key: string): Promise<Response | undefined>;
  delete(key: string): Promise<boolean>;
}

/** The slice of `CacheStorage` this store uses. */
export interface ModelCacheStorage {
  open(name: string): Promise<ModelCacheLike>;
  delete(name: string): Promise<boolean>;
}

/** `navigator.storage`, narrowed. Optional: a browser without it is asked nothing. */
export interface ModelStorageManager {
  estimate(): Promise<{ readonly quota?: number; readonly usage?: number }>;
  persist?(): Promise<boolean>;
}

export type ModelFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ModelInstallErrorCode = 'no-storage' | 'quota' | 'network' | 'integrity' | 'cancelled' | 'not-installed';

export class ModelInstallError extends Error {
  readonly code: ModelInstallErrorCode;

  constructor(code: ModelInstallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelInstallError';
    this.code = code;
  }
}

export interface ModelInstallProgress {
  /** The file in flight. */
  readonly label: string;
  /** Across every file, including what an earlier, interrupted install already stored. */
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}

export type ModelStoreStatus =
  | { readonly state: 'installed'; readonly version: string; readonly bytes: number; readonly installedAt: string }
  | { readonly state: 'partial'; readonly downloadedBytes: number }
  | { readonly state: 'absent' };

export interface ModelInstallOptions {
  readonly signal?: AbortSignal;
  onProgress?(progress: ModelInstallProgress): void;
}

/** What a voice service needs from a store: the install, never the bytes. */
export interface ModelInstaller {
  readonly totalBytes: number;
  status(): Promise<ModelStoreStatus>;
  install(options?: ModelInstallOptions): Promise<void>;
  remove(): Promise<void>;
}

export interface PinnedModelStoreOptions {
  readonly bundle: PinnedBundle;
  /** `null` where the browser has no Cache Storage (an insecure page, some private windows). */
  readonly caches: ModelCacheStorage | null;
  readonly fetch: ModelFetch;
  readonly storage?: ModelStorageManager | null;
  readonly now?: () => Date;
  /** Defaults to {@link MODEL_PART_BYTES}; tests use tiny parts over tiny files. */
  readonly partBytes?: number;
}

interface ProgressRecord {
  readonly sha256: string;
  readonly parts: number;
  readonly hash: Sha256State;
}

interface CompleteRecord {
  readonly sha256: string;
}

interface InstalledRecord {
  readonly version: string;
  readonly bytes: number;
  readonly installedAt: string;
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const cancelled = (): ModelInstallError => new ModelInstallError('cancelled', 'The download was cancelled.');

const nameOf = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
};

export class PinnedModelStore implements ModelInstaller {
  readonly #options: PinnedModelStoreOptions;
  readonly #bundle: PinnedBundle;
  readonly #partBytes: number;

  constructor(options: PinnedModelStoreOptions) {
    this.#options = options;
    this.#bundle = options.bundle;
    this.#partBytes = options.partBytes ?? MODEL_PART_BYTES;
  }

  /** Every byte a complete install holds. */
  get totalBytes(): number {
    return this.#bundle.files.reduce((total, file) => total + file.bytes, 0);
  }

  async status(): Promise<ModelStoreStatus> {
    const cache = await this.#open().catch(() => null);
    if (cache === null) return { state: 'absent' };
    const installed = await this.#record<InstalledRecord>(cache, this.#installedKey());
    let downloaded = 0;
    let complete = true;
    for (const file of this.#bundle.files) {
      if (await this.#isComplete(cache, file)) {
        downloaded += file.bytes;
        continue;
      }
      complete = false;
      downloaded += (await this.#progress(cache, file))?.hash.length ?? 0;
    }
    if (complete && installed !== null && typeof installed.installedAt === 'string')
      return {
        state: 'installed',
        version: this.#bundle.versionLabel,
        bytes: this.totalBytes,
        installedAt: installed.installedAt,
      };
    return downloaded > 0 ? { state: 'partial', downloadedBytes: downloaded } : { state: 'absent' };
  }

  /**
   * Download whatever is missing, verify it, and mark the install complete. Resumes an earlier,
   * interrupted install. Rejects with a {@link ModelInstallError}; a cancelled install keeps every
   * part it finished.
   */
  async install(options: ModelInstallOptions = {}): Promise<void> {
    const cache = await this.#open();
    const { signal, onProgress } = options;
    const total = this.totalBytes;
    let finished = 0;
    for (const file of this.#bundle.files) {
      if (await this.#isComplete(cache, file)) finished += file.bytes;
    }
    await this.#checkRoom(total - finished);
    // Best effort: ask the browser not to evict a large download under storage pressure. A refusal
    // changes nothing here; Settings says the browser may still reclaim it.
    await this.#options.storage?.persist?.().catch(() => false);

    let done = 0;
    for (const file of this.#bundle.files) {
      if (signal?.aborted) throw cancelled();
      if (await this.#isComplete(cache, file)) {
        done += file.bytes;
        onProgress?.({ label: file.label, downloadedBytes: done, totalBytes: total });
        continue;
      }
      const before = done;
      await this.#installFile(cache, file, signal, bytes =>
        onProgress?.({ label: file.label, downloadedBytes: before + bytes, totalBytes: total }),
      );
      done += file.bytes;
    }
    await this.#put(
      cache,
      this.#installedKey(),
      json({
        version: this.#bundle.versionLabel,
        bytes: total,
        installedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      } satisfies InstalledRecord),
    );
  }

  /** Delete every stored byte, finished or not. */
  async remove(): Promise<void> {
    await this.#options.caches?.delete(this.#bundle.cache);
  }

  /** Read the installed bundle back, every file verified again, by role. */
  async read(): Promise<ReadonlyMap<string, Uint8Array>> {
    const cache = await this.#open();
    const bytes = new Map<string, Uint8Array>();
    for (const file of this.#bundle.files) {
      if (!(await this.#isComplete(cache, file)))
        throw new ModelInstallError(
          'not-installed',
          `${this.#bundle.name} is not installed on this device. Install it in Settings › Voice.`,
        );
      const whole = new Uint8Array(file.bytes);
      const hasher = new Sha256();
      for (let index = 0, offset = 0; offset < file.bytes; index += 1) {
        const part = await cache.match(this.#partKey(file.role, index));
        const chunk = part === undefined ? new Uint8Array() : new Uint8Array(await part.arrayBuffer());
        if (chunk.length === 0 || offset + chunk.length > file.bytes) break;
        whole.set(chunk, offset);
        hasher.update(chunk);
        offset += chunk.length;
      }
      if (hasher.length !== file.bytes || hasher.hex() !== file.sha256)
        throw new ModelInstallError(
          'integrity',
          `${file.label} changed on this device since it was installed. Remove ${this.#bundle.name} and install it again.`,
        );
      bytes.set(file.role, whole);
    }
    return bytes;
  }

  #installedKey(): string {
    return `${this.#bundle.keyRoot}/installed`;
  }

  #fileKey(role: string, leaf: string): string {
    return `${this.#bundle.keyRoot}/${role}/${leaf}`;
  }

  #partKey(role: string, index: number): string {
    return this.#fileKey(role, `part-${String(index).padStart(4, '0')}`);
  }

  async #open(): Promise<ModelCacheLike> {
    const caches = this.#options.caches;
    if (caches === null)
      throw new ModelInstallError('no-storage', 'This browser cannot keep the speech model on this device.');
    return await caches.open(this.#bundle.cache);
  }

  async #record<T>(cache: ModelCacheLike, key: string): Promise<T | null> {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit === undefined) return null;
    const value: unknown = await hit.json().catch(() => null);
    return typeof value === 'object' && value !== null ? (value as T) : null;
  }

  async #isComplete(cache: ModelCacheLike, file: PinnedFile): Promise<boolean> {
    return (await this.#record<CompleteRecord>(cache, this.#fileKey(file.role, 'complete')))?.sha256 === file.sha256;
  }

  /** The resume point, or `null` when there is none this exact file can trust. */
  async #progress(cache: ModelCacheLike, file: PinnedFile): Promise<ProgressRecord | null> {
    const record = await this.#record<ProgressRecord>(cache, this.#fileKey(file.role, 'progress'));
    if (record === null || record.sha256 !== file.sha256 || !isSha256State(record.hash)) return null;
    const { length } = record.hash;
    if (length > file.bytes || record.parts !== Math.ceil(length / this.#partBytes)) return null;
    return record;
  }

  async #checkRoom(needed: number): Promise<void> {
    const estimate = await this.#options.storage?.estimate().catch(() => null);
    if (typeof estimate?.quota !== 'number' || typeof estimate.usage !== 'number') return;
    const free = estimate.quota - estimate.usage;
    if (free >= needed) return;
    throw new ModelInstallError(
      'quota',
      `This browser can store about ${formatMegabytes(free)} more here, and ${this.#bundle.name} needs ${formatMegabytes(needed)}. Free some space on this device, then try again.`,
    );
  }

  async #installFile(
    cache: ModelCacheLike,
    file: PinnedFile,
    signal: AbortSignal | undefined,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    let progress = await this.#progress(cache, file);
    // Every byte is already stored when an install stopped between its last part and marking the file
    // complete. Verify what is there instead of asking for a range that starts at the file's end.
    const stored = progress !== null && progress.hash.length === file.bytes;
    const response = stored ? null : await this.#request(file, progress?.hash.length ?? 0, signal);
    if (response !== null && progress !== null && progress.hash.length > 0 && response.status !== 206) {
      // The server ignored the range and is sending the whole file. Start this file over rather
      // than guess how its bytes line up with the ones already stored.
      progress = null;
    }
    const hasher = new Sha256(progress?.hash);
    let parts = progress?.parts ?? 0;
    const part = new Uint8Array(Math.min(this.#partBytes, file.bytes));
    let filled = 0;
    onBytes(hasher.length);

    const flush = async (): Promise<void> => {
      await this.#put(cache, this.#partKey(file.role, parts), new Response(part.slice(0, filled)));
      parts += 1;
      filled = 0;
      await this.#put(
        cache,
        this.#fileKey(file.role, 'progress'),
        json({ sha256: file.sha256, parts, hash: hasher.state() } satisfies ProgressRecord),
      );
    };

    const body =
      response === null ? new ReadableStream<Uint8Array>({ start: controller => controller.close() }) : response.body;
    if (body === null) throw new ModelInstallError('network', `${file.label} arrived without a body.`);
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.length) {
          if (hasher.length >= file.bytes)
            throw new ModelInstallError('integrity', `${file.label} is larger than the pinned file. Nothing was kept.`);
          const take = Math.min(part.length - filled, value.length - offset, file.bytes - hasher.length);
          const piece = value.subarray(offset, offset + take);
          part.set(piece, filled);
          hasher.update(piece);
          filled += take;
          offset += take;
          if (filled === part.length || hasher.length === file.bytes) await flush();
        }
        onBytes(hasher.length);
      }
    } catch (error) {
      if (error instanceof ModelInstallError) {
        if (error.code === 'integrity') await this.#forget(cache, file);
        throw error;
      }
      if (signal?.aborted || nameOf(error) === 'AbortError') throw cancelled();
      throw new ModelInstallError(
        'network',
        `${file.label} stopped downloading. Resume to carry on where it stopped.`,
        {
          cause: error,
        },
      );
    }

    if (hasher.length !== file.bytes)
      throw new ModelInstallError(
        'network',
        `${file.label} stopped at ${formatMegabytes(hasher.length)} of ${formatMegabytes(file.bytes)}. Resume to carry on where it stopped.`,
      );
    if (hasher.hex() !== file.sha256) {
      await this.#forget(cache, file);
      throw new ModelInstallError(
        'integrity',
        `${file.label} did not match the pinned SHA-256, so it was deleted. Try again.`,
      );
    }
    await this.#put(
      cache,
      this.#fileKey(file.role, 'complete'),
      json({ sha256: file.sha256 } satisfies CompleteRecord),
    );
  }

  async #request(file: PinnedFile, offset: number, signal: AbortSignal | undefined): Promise<Response> {
    let response: Response;
    try {
      response = await this.#options.fetch(file.url, {
        ...(signal === undefined ? {} : { signal }),
        ...(offset > 0 ? { headers: { range: `bytes=${offset}-` } } : {}),
      });
    } catch (error) {
      if (signal?.aborted || nameOf(error) === 'AbortError') throw cancelled();
      throw new ModelInstallError('network', `${file.label} could not be downloaded. Check this device’s connection.`, {
        cause: error,
      });
    }
    if (!response.ok)
      throw new ModelInstallError('network', `${file.label} could not be downloaded (HTTP ${response.status}).`);
    return response;
  }

  async #put(cache: ModelCacheLike, key: string, response: Response): Promise<void> {
    try {
      await cache.put(key, response);
    } catch (error) {
      if (nameOf(error) === 'QuotaExceededError')
        throw new ModelInstallError(
          'quota',
          'This device ran out of room for the speech model. Free some space, then resume.',
          {
            cause: error,
          },
        );
      throw error;
    }
  }

  /** Drop every stored byte of one file, so a bad file is downloaded again from the start. */
  async #forget(cache: ModelCacheLike, file: PinnedFile): Promise<void> {
    const parts = Math.ceil(file.bytes / this.#partBytes);
    for (let index = 0; index < parts; index += 1) await cache.delete(this.#partKey(file.role, index));
    await cache.delete(this.#fileKey(file.role, 'progress'));
    await cache.delete(this.#fileKey(file.role, 'complete'));
  }
}
