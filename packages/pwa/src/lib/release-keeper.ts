/**
 * THE RELEASE KEEPER — what the service worker does with a release once it has one to look at.
 *
 * It fetches the signed list, asks `release-verification.ts` whether to believe it, fetches every
 * listed file, checks every hash, writes them into a NEW cache, and only then moves one pointer.
 * The pointer and the pinned trust are one IndexedDB record written in one transaction, so a worker
 * killed halfway through leaves the installed release exactly as it was; an orphaned cache is pruned
 * by the next run. Nothing here reaches a browser global: the network, Cache Storage and IndexedDB
 * arrive as small ports (`ReleaseNetwork`, `ReleaseCaches`, `ReleaseStateStore`) and
 * `src/worker/service-worker.ts` binds them. See `docs/pwa-release-signing.md`.
 */

import {
  type ReleaseManifest,
  type ReleaseRewrite,
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  ReleaseManifestSchema,
  releasePathForRequest,
} from './release-manifest.ts';
import {
  type ReleaseRefusal,
  type ReleaseTrust,
  firstUseTrust,
  verifyReleaseFile,
  verifyReleaseManifest,
  sha256Base64Url,
} from './release-verification.ts';

/** One file as the network answered it. Headers are kept so a cached page keeps its security policy. */
export interface ReleaseFile {
  readonly bytes: Uint8Array;
  readonly headers: readonly (readonly [string, string])[];
}

/** The site's own origin, never a daemon, always bypassing every HTTP cache. */
export interface ReleaseNetwork {
  /** `null` when the file could not be fetched at all (offline, or not a 2xx). */
  get(path: string): Promise<ReleaseFile | null>;
}

/** Cache Storage, reduced to what a release needs. */
export interface ReleaseCaches {
  put(cacheName: string, path: string, file: ReleaseFile): Promise<void>;
  get(cacheName: string, path: string): Promise<ReleaseFile | null>;
  names(): Promise<readonly string[]>;
  remove(cacheName: string): Promise<void>;
}

/** A release the worker can serve: where its bytes are, and the list they were checked against. */
export interface InstalledRelease {
  readonly cacheName: string;
  readonly manifest: ReleaseManifest;
}

/** What the last update check concluded, kept so a page that opens later can still be told. */
export type ReleaseOutcome =
  | { readonly status: 'current' }
  | { readonly status: 'updated' }
  | { readonly status: 'unverified' }
  | { readonly status: 'unreachable' }
  | { readonly status: 'refused'; readonly refusal: ReleaseRefusal; readonly hadRelease: boolean };

/** Everything the worker keeps, as ONE record so the swap is one write. */
export interface KeeperState {
  readonly trust: ReleaseTrust;
  readonly active: InstalledRelease | null;
  /** The release before `active`, kept so a page still running it can lazy-load its own files. */
  readonly previous: InstalledRelease | null;
  readonly lastOutcome: ReleaseOutcome | null;
}

export interface ReleaseStateStore {
  load(): Promise<KeeperState | null>;
  save(state: KeeperState): Promise<void>;
}

/** Every cache this module owns starts with this, so pruning never touches anybody else's. */
export const RELEASE_CACHE_PREFIX = 'fy-release-';

const cacheNameFor = (manifest: ReleaseManifest): string =>
  `${RELEASE_CACHE_PREFIX}${manifest.commit}-${Date.parse(manifest.createdAt)}`;

export interface ReleaseKeeperOptions {
  readonly network: ReleaseNetwork;
  readonly caches: ReleaseCaches;
  readonly state: ReleaseStateStore;
  /** The key compiled into this worker. It is pinned only when nothing is pinned yet. */
  readonly compiledKey: string;
  /** True only on a developer's own machine (a loopback hostname). */
  readonly allowUnsigned: boolean;
  /** The app's rewrites from `_redirects`, compiled in by the build. */
  readonly rewrites: readonly ReleaseRewrite[];
}

const decoder = new TextDecoder();

/** Re-checks a stored record instead of trusting it: a page shares this origin's IndexedDB. */
const storedManifest = (release: InstalledRelease | null): InstalledRelease | null =>
  release !== null && ReleaseManifestSchema.safeParse(release.manifest).success ? release : null;

export class ReleaseKeeper {
  /** One update at a time: a second caller waits for, and is told, the first one's answer. */
  #running: Promise<ReleaseOutcome> | null = null;

  constructor(private readonly options: ReleaseKeeperOptions) {}

  async #load(): Promise<KeeperState> {
    const stored = await this.options.state.load();
    return {
      trust: stored?.trust ?? firstUseTrust(this.options.compiledKey),
      active: storedManifest(stored?.active ?? null),
      previous: storedManifest(stored?.previous ?? null),
      lastOutcome: stored?.lastOutcome ?? null,
    };
  }

  /** The last update check's outcome, for a page that has just opened. */
  async lastOutcome(): Promise<ReleaseOutcome | null> {
    return (await this.#load()).lastOutcome;
  }

  /** Fetches, verifies and installs the release the site serves now. */
  update(): Promise<ReleaseOutcome> {
    this.#running ??= this.#update().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #update(): Promise<ReleaseOutcome> {
    const state = await this.#load();
    const outcome = await this.#check(state);
    // `updated` already wrote its own record; a no-op answer must not rewrite trust it did not read.
    if (outcome.status !== 'updated') await this.options.state.save({ ...(await this.#load()), lastOutcome: outcome });
    return outcome;
  }

  async #check(state: KeeperState): Promise<ReleaseOutcome> {
    const { network } = this.options;
    const [manifestFile, signatureFile] = await Promise.all([
      network.get(RELEASE_MANIFEST_FILE),
      network.get(RELEASE_SIGNATURE_FILE),
    ]);
    if (manifestFile === null || signatureFile === null) return { status: 'unreachable' };

    const hadRelease = state.active !== null;
    const decision = await verifyReleaseManifest(
      { manifestBytes: manifestFile.bytes, signatureText: decoder.decode(signatureFile.bytes) },
      state.trust,
      { allowUnsigned: this.options.allowUnsigned },
    );
    if (!decision.accepted) {
      return decision.unverified === true
        ? { status: 'unverified' }
        : { status: 'refused', refusal: decision.refusal, hadRelease };
    }

    const { manifest } = decision;
    const cacheName = cacheNameFor(manifest);
    if (state.active?.cacheName === cacheName) return { status: 'current' };

    const fetched = await this.#fetchAll(manifest, state.active);
    if (fetched === 'unreachable') return { status: 'unreachable' };
    if (fetched === 'hash-mismatch') return { status: 'refused', refusal: 'hash-mismatch', hadRelease };

    for (const [path, file] of fetched) await this.options.caches.put(cacheName, path, file);
    const outcome: ReleaseOutcome = { status: 'updated' };
    // THE SWAP. Nothing before this line changed what the worker serves.
    await this.options.state.save({
      trust: decision.trust,
      active: { cacheName, manifest },
      previous: state.active,
      lastOutcome: outcome,
    });
    await this.#prune([cacheName, state.active?.cacheName]);
    return outcome;
  }

  /** Every listed file, checked; an unchanged file is reused from the installed release. */
  async #fetchAll(
    manifest: ReleaseManifest,
    active: InstalledRelease | null,
  ): Promise<Map<string, ReleaseFile> | 'unreachable' | 'hash-mismatch'> {
    const files = new Map<string, ReleaseFile>();
    for (const path of Object.keys(manifest.files)) {
      const reusable = active !== null && active.manifest.files[path] === manifest.files[path];
      const cached = reusable ? await this.options.caches.get(active.cacheName, path) : null;
      const file = cached ?? (await this.options.network.get(path));
      if (file === null) return 'unreachable';
      if (!(await verifyReleaseFile(manifest, path, file.bytes))) return 'hash-mismatch';
      files.set(path, file);
    }
    return files;
  }

  async #prune(keep: readonly (string | undefined)[]): Promise<void> {
    for (const name of await this.options.caches.names()) {
      if (name.startsWith(RELEASE_CACHE_PREFIX) && !keep.includes(name)) await this.options.caches.remove(name);
    }
  }

  /**
   * The verified bytes that answer a request, or `null` to let it reach the network untouched.
   * The worker script and the signed list themselves are never answered from a cache: the browser
   * and the keeper must always see what the site serves now.
   */
  async respond(request: { readonly pathname: string; readonly navigate: boolean }): Promise<ReleaseFile | null> {
    const own = request.pathname.slice(1);
    if (own === RELEASE_MANIFEST_FILE || own === RELEASE_SIGNATURE_FILE) return null;
    const state = await this.#load();
    for (const release of [state.active, state.previous]) {
      if (release === null || own === release.manifest.worker) continue;
      const path = releasePathForRequest(request, release.manifest.files, this.options.rewrites);
      if (path !== null) return await this.options.caches.get(release.cacheName, path);
    }
    return null;
  }

  /**
   * Whether a worker script at `path` is the worker a verified release names, byte for byte. Runs an
   * update first, so a legitimately new worker is checked against the release that introduced it.
   */
  async isSignedWorker(path: string, script: Uint8Array): Promise<boolean> {
    await this.update();
    const { active } = await this.#load();
    return (
      active !== null &&
      active.manifest.worker === path &&
      active.manifest.files[path] === (await sha256Base64Url(script))
    );
  }
}

/* ---------- the page ↔ worker messages ----------------------------------- */

/** Page → worker. Every reply travels back on the `MessagePort` the page sends with it. */
export type ReleaseRequestMessage =
  | { readonly type: 'fy-release-status' }
  | { readonly type: 'fy-release-check' }
  | { readonly type: 'fy-release-audit-worker'; readonly scriptUrl: string };

/** Worker → page, as a reply or as a broadcast after a check nobody asked for. */
export type ReleaseReplyMessage =
  | { readonly type: 'fy-release-outcome'; readonly outcome: ReleaseOutcome | null }
  | { readonly type: 'fy-release-worker-audit'; readonly signed: boolean };

export const parseReleaseRequest = (data: unknown): ReleaseRequestMessage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { type, scriptUrl } = data as { readonly type?: unknown; readonly scriptUrl?: unknown };
  if (type === 'fy-release-status' || type === 'fy-release-check') return { type };
  if (type === 'fy-release-audit-worker' && typeof scriptUrl === 'string') return { type, scriptUrl };
  return null;
};

/**
 * The worker's side of one message. `origin` is the worker's own; a script URL anywhere else is
 * unsigned by definition and is never fetched. `network` reads the script the browser is installing.
 */
export const answerReleaseRequest = async (
  keeper: ReleaseKeeper,
  request: ReleaseRequestMessage,
  origin: string,
  network: ReleaseNetwork,
): Promise<ReleaseReplyMessage> => {
  if (request.type === 'fy-release-status') return { type: 'fy-release-outcome', outcome: await keeper.lastOutcome() };
  if (request.type === 'fy-release-check') return { type: 'fy-release-outcome', outcome: await keeper.update() };
  const url = URL.parse(request.scriptUrl);
  if (url === null || url.origin !== origin) return { type: 'fy-release-worker-audit', signed: false };
  const path = url.pathname.slice(1);
  const script = await network.get(path);
  return {
    type: 'fy-release-worker-audit',
    signed: script !== null && (await keeper.isSignedWorker(path, script.bytes)),
  };
};

/** The reply, or `null` for anything a worker did not send. */
export const parseReleaseReply = (data: unknown): ReleaseReplyMessage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { readonly type?: unknown; readonly outcome?: unknown; readonly signed?: unknown };
  if (message.type === 'fy-release-worker-audit' && typeof message.signed === 'boolean')
    return { type: message.type, signed: message.signed };
  if (message.type !== 'fy-release-outcome') return null;
  const outcome = message.outcome as { readonly status?: unknown } | null | undefined;
  if (outcome === null) return { type: message.type, outcome: null };
  return typeof outcome?.status === 'string'
    ? { type: message.type, outcome: message.outcome as ReleaseOutcome }
    : null;
};
