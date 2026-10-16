/**
 * THE RELEASE KEEPER — what the service worker does with a release once it has one to look at.
 *
 * It fetches the signed list, asks `release-verification.ts` whether to believe it, fetches every
 * listed file, checks every hash, writes them into a NEW cache, and only then moves one pointer.
 * The pointer is one IndexedDB record written in one transaction, so a worker killed halfway through
 * leaves the installed release exactly as it was; an orphaned cache is pruned by the next run.
 *
 * NOTHING IT STORES IS TRUSTED. IndexedDB and Cache Storage belong to the ORIGIN, not to the worker:
 * any script that ever runs on this site can read and rewrite both. So the record holds signed BYTES
 * (the list exactly as served, and its signature), never a conclusion such as "this key is trusted"
 * or "this release was verified", and every read re-checks them from the key compiled into this
 * worker. Every cached body is re-hashed against the re-verified list before it is served, and one
 * that no longer matches is fetched again rather than served or trusted. Headers are never stored at
 * all: the worker serves the ones `public/_headers` names (`release-headers.ts`).
 *
 * Nothing here reaches a browser global: the network, Cache Storage and IndexedDB arrive as small
 * ports (`ReleaseNetwork`, `ReleaseCaches`, `ReleaseStateStore`) and `src/worker/service-worker.ts`
 * binds them. See `docs/pwa-release-signing.md`.
 */

import { z } from 'zod';
import { type ReleaseHeaderRule, releaseHeadersFor } from './release-headers.ts';
import {
  isDeferredReleaseFile,
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  type ReleaseManifest,
  type ReleaseRewrite,
  releasePathForRequest,
} from './release-manifest.ts';
import {
  checkReleaseSignature,
  type InstalledOrder,
  RELEASE_REFUSAL_WORDS,
  type ReleaseRefusal,
  releaseKeyChain,
  type SignatureCheck,
  type SignedRelease,
  sha256Base64Url,
  verifyReleaseFile,
  verifyReleaseManifest,
} from './release-verification.ts';

/** The site's own origin, never a daemon, always bypassing every HTTP cache. */
export interface ReleaseNetwork {
  /** A file's bytes, or `null` when it could not be fetched at all (offline, or not a 2xx). */
  get(path: string): Promise<Uint8Array | null>;
}

/** Cache Storage, reduced to what a release needs: bytes by path, and nothing else. */
export interface ReleaseCaches {
  put(cacheName: string, path: string, bytes: Uint8Array): Promise<void>;
  get(cacheName: string, path: string): Promise<Uint8Array | null>;
  names(): Promise<readonly string[]>;
  remove(cacheName: string): Promise<void>;
}

/** What the last update check concluded, kept so a page that opens later can still be told. */
export type ReleaseOutcome =
  | { readonly status: 'current' }
  | { readonly status: 'updated' }
  | { readonly status: 'unverified' }
  | { readonly status: 'unreachable' }
  | { readonly status: 'refused'; readonly refusal: ReleaseRefusal; readonly hadRelease: boolean };

const ReleaseOutcomeSchema: z.ZodType<ReleaseOutcome> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('current') }),
  z.strictObject({ status: z.literal('updated') }),
  z.strictObject({ status: z.literal('unverified') }),
  z.strictObject({ status: z.literal('unreachable') }),
  z.strictObject({
    status: z.literal('refused'),
    refusal: z.enum(Object.keys(RELEASE_REFUSAL_WORDS) as [ReleaseRefusal, ...ReleaseRefusal[]]),
    hadRelease: z.boolean(),
  }),
]);

/**
 * Everything the worker keeps, as ONE record so the swap is one write. Every field is input to be
 * re-checked, never a fact: a page on this origin may have written any of it.
 */
export interface KeeperState {
  /** The release this worker serves, as it was signed. */
  readonly active: SignedRelease | null;
  /** The release before `active`, kept so a page still running it can lazy-load its own chunks. */
  readonly previous: SignedRelease | null;
  /**
   * Accepted releases that announced a `nextKey`. They are the ONLY way a key other than the
   * compiled-in one becomes trusted, and each is re-verified every time it is read.
   */
  readonly endorsements: readonly SignedRelease[];
  /** What the last check concluded. Shown to the reader, never used to decide anything. */
  readonly lastOutcome: ReleaseOutcome | null;
}

export interface ReleaseStateStore {
  /** Whatever the record holds now — possibly something a page wrote — or `null`. */
  load(): Promise<unknown>;
  save(state: KeeperState): Promise<void>;
}

/** Every cache this module owns starts with this, so pruning never touches anybody else's. */
export const RELEASE_CACHE_PREFIX = 'fy-release-';

/** Derived from the signed list, never stored: a stored name could point anywhere. */
const cacheNameFor = (manifest: ReleaseManifest): string =>
  `${RELEASE_CACHE_PREFIX}${manifest.commit}-${manifest.sequence}`;

/** Enough endorsements for a few planned rotations; older ones only ever widened the chain further back. */
const ENDORSEMENT_LIMIT = 8;

export interface ReleaseKeeperOptions {
  readonly network: ReleaseNetwork;
  readonly caches: ReleaseCaches;
  readonly state: ReleaseStateStore;
  /** The key compiled into this worker: the one anchor every stored byte is re-checked from. */
  readonly compiledKey: string;
  /** True only on a developer's own machine (a loopback hostname). */
  readonly allowUnsigned: boolean;
  /** The app's rewrites from `_redirects`, compiled in by the build. */
  readonly rewrites: readonly ReleaseRewrite[];
  /** The app's header rules from `_headers`, compiled in by the build. */
  readonly headers: readonly ReleaseHeaderRule[];
}

/** An answer the worker turns into a `Response` as it is: status, the bytes, and the headers. */
export interface ReleaseResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly headers: readonly (readonly [string, string])[];
}

/** A stored release after its signature was checked again, just now. */
interface VerifiedRelease {
  readonly signed: SignedRelease;
  readonly manifest: ReleaseManifest;
  readonly signerRank: number;
  readonly cacheName: string;
}

interface VerifiedState {
  readonly chain: readonly string[];
  readonly active: VerifiedRelease | null;
  readonly previous: VerifiedRelease | null;
  readonly endorsements: readonly SignedRelease[];
  readonly lastOutcome: ReleaseOutcome | null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A stored value shaped like a signed release, or `null`. The shape is all this proves. */
const signedRelease = (value: unknown): SignedRelease | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { manifestBytes, signatureText } = value as Partial<Record<keyof SignedRelease, unknown>>;
  return manifestBytes instanceof Uint8Array && typeof signatureText === 'string'
    ? { manifestBytes, signatureText }
    : null;
};

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;

const installedOrder = (release: VerifiedRelease | null): InstalledOrder | null =>
  release === null
    ? null
    : { sequence: release.manifest.sequence, commit: release.manifest.commit, signerRank: release.signerRank };

/** The answer to a request the worker must answer but cannot answer with verified bytes. */
const UNVERIFIABLE_BODY = encoder.encode(
  'This part of Ferretry could not be checked against its signed release, so it was not loaded.\n',
);

/** At most this many signature checks are remembered. */
const CHECK_MEMO_LIMIT = 32;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export class ReleaseKeeper {
  /** One update at a time: a second caller waits for, and is told, the first one's answer. */
  #running: Promise<ReleaseOutcome> | null = null;
  /**
   * Signature checks already made, so a request does not cost an Ed25519 verify. Keyed by the chain
   * and the signature text, and a hit counts only if the bytes are THE SAME bytes: a page can pair a
   * genuine signature with bytes of its own, so the signature alone names nothing. This memory is
   * the worker's own — no page can write it.
   */
  readonly #checks = new Map<string, { readonly bytes: Uint8Array; readonly check: Promise<SignatureCheck> }>();
  /**
   * The highest release sequence this worker has installed or confirmed FROM THE SITE since it
   * started. A stored release below it is one a page put back — an older release whose bug the newer
   * one fixed — so it is not served (`docs/pwa-release-signing.md`). Worker memory, so it starts at 0
   * each time the browser starts the worker; the worker re-checks the site on every page load.
   */
  #floor = 0;

  constructor(private readonly options: ReleaseKeeperOptions) {}

  #check(release: SignedRelease, chain: readonly string[]): Promise<SignatureCheck> {
    const key = `${chain.join(' ')}\n${release.signatureText}`;
    const known = this.#checks.get(key);
    if (known !== undefined && sameBytes(known.bytes, release.manifestBytes)) return known.check;
    if (this.#checks.size >= CHECK_MEMO_LIMIT) this.#checks.clear();
    const check = checkReleaseSignature(release, chain, { allowUnsigned: false });
    this.#checks.set(key, { bytes: release.manifestBytes, check });
    return check;
  }

  async #reverify(value: unknown, chain: readonly string[]): Promise<VerifiedRelease | null> {
    const signed = signedRelease(value);
    if (signed === null) return null;
    const check = await this.#check(signed, chain);
    return check.ok
      ? { signed, manifest: check.manifest, signerRank: check.signerRank, cacheName: cacheNameFor(check.manifest) }
      : null;
  }

  /** The stored record, re-checked from the compiled-in key. Whatever does not verify is dropped. */
  async #load(): Promise<VerifiedState> {
    const stored = await this.options.state.load();
    const listed = field(stored, 'endorsements');
    const candidates = (Array.isArray(listed) ? listed.slice(-ENDORSEMENT_LIMIT) : []).flatMap(
      item => signedRelease(item) ?? [],
    );
    const chain = await releaseKeyChain(this.options.compiledKey, candidates, (release, keys) =>
      this.#check(release, keys),
    );
    const endorsements: SignedRelease[] = [];
    for (const endorsement of candidates) {
      if ((await this.#check(endorsement, chain)).ok) endorsements.push(endorsement);
    }
    const outcome = ReleaseOutcomeSchema.safeParse(field(stored, 'lastOutcome'));
    const active = await this.#reverify(field(stored, 'active'), chain);
    return {
      chain,
      active: active !== null && active.manifest.sequence < this.#floor ? null : active,
      previous: await this.#reverify(field(stored, 'previous'), chain),
      endorsements,
      lastOutcome: outcome.success ? outcome.data : null,
    };
  }

  async #save(state: VerifiedState, changes: Partial<KeeperState>): Promise<void> {
    await this.options.state.save({
      active: state.active?.signed ?? null,
      previous: state.previous?.signed ?? null,
      endorsements: state.endorsements,
      lastOutcome: state.lastOutcome,
      ...changes,
    });
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
    const outcome = await this.#install(await this.#load());
    // `updated` already wrote its own record. Anything else rewrites only the outcome — and, in
    // passing, drops whatever in the record did not verify.
    if (outcome.status !== 'updated') await this.#save(await this.#load(), { lastOutcome: outcome });
    return outcome;
  }

  async #candidate(): Promise<SignedRelease | null> {
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.options.network.get(RELEASE_MANIFEST_FILE),
      this.options.network.get(RELEASE_SIGNATURE_FILE),
    ]);
    return manifestBytes === null || signatureBytes === null
      ? null
      : { manifestBytes, signatureText: decoder.decode(signatureBytes) };
  }

  async #install(state: VerifiedState): Promise<ReleaseOutcome> {
    const candidate = await this.#candidate();
    if (candidate === null) return { status: 'unreachable' };

    const hadRelease = state.active !== null;
    const decision = await verifyReleaseManifest(candidate, state.chain, installedOrder(state.active), {
      allowUnsigned: this.options.allowUnsigned,
    });
    if (!decision.accepted) {
      return decision.unverified === true
        ? { status: 'unverified' }
        : { status: 'refused', refusal: decision.refusal, hadRelease };
    }
    if (decision.standing === 'same') {
      this.#floor = Math.max(this.#floor, decision.manifest.sequence);
      return { status: 'current' };
    }

    const { manifest } = decision;
    const cacheName = cacheNameFor(manifest);
    const fetched = await this.#fetchAll(manifest, state.active);
    if (fetched === 'unreachable') return { status: 'unreachable' };
    if (fetched === 'hash-mismatch') return { status: 'refused', refusal: 'hash-mismatch', hadRelease };

    for (const [path, bytes] of fetched) await this.options.caches.put(cacheName, path, bytes);
    const outcome: ReleaseOutcome = { status: 'updated' };
    // THE SWAP. Nothing before this line changed what the worker serves.
    await this.#save(state, {
      active: candidate,
      previous: state.active?.signed ?? null,
      endorsements:
        manifest.nextKey === undefined
          ? state.endorsements
          : [...state.endorsements, candidate].slice(-ENDORSEMENT_LIMIT),
      lastOutcome: outcome,
    });
    this.#floor = Math.max(this.#floor, manifest.sequence);
    await this.#prune([cacheName, state.active?.cacheName]);
    return outcome;
  }

  /**
   * Every listed file, checked. An unchanged file is reused from the installed release only if its
   * cached bytes STILL hash to the listed value; a copy a page rewrote is fetched again, so a
   * tampered cache can neither poison the new release nor make a good release look like a bad deploy.
   *
   * A DEFERRED file (`isDeferredReleaseFile`) is skipped here: it is verified when something asks for it.
   */
  async #fetchAll(
    manifest: ReleaseManifest,
    active: VerifiedRelease | null,
  ): Promise<Map<string, Uint8Array> | 'unreachable' | 'hash-mismatch'> {
    const files = new Map<string, Uint8Array>();
    for (const path of Object.keys(manifest.files)) {
      if (isDeferredReleaseFile(path)) continue;
      const reusable = active !== null && active.manifest.files[path] === manifest.files[path];
      const cached = reusable ? await this.options.caches.get(active.cacheName, path) : null;
      const intact = cached !== null && (await verifyReleaseFile(manifest, path, cached)) ? cached : null;
      const bytes = intact ?? (await this.options.network.get(path));
      if (bytes === null) return 'unreachable';
      if (!(await verifyReleaseFile(manifest, path, bytes))) return 'hash-mismatch';
      files.set(path, bytes);
    }
    return files;
  }

  async #prune(keep: readonly (string | undefined)[]): Promise<void> {
    for (const name of await this.options.caches.names()) {
      if (name.startsWith(RELEASE_CACHE_PREFIX) && !keep.includes(name)) await this.options.caches.remove(name);
    }
  }

  /**
   * How the worker answers a same-origin GET, or `null` to let it reach the network untouched.
   *
   * ONCE A VERIFIED RELEASE EXISTS, NO NAVIGATION REACHES THE NETWORK. Every page load is answered
   * from the release — a listed page, a rewrite, or the release's own `index.html` for anything else
   * (the signed list and its signature included). A deploy that adds a page, or serves HTML at a path
   * the release does not list, therefore cannot put a document on this origin for anyone who has
   * the app installed.
   *
   * A subresource is answered from the release when the release lists it. The worker script and the
   * signed list themselves always come from the network, so the browser and the keeper see what the
   * site serves now. The PREVIOUS release answers only for a hashed `assets/` chunk, which a page that
   * is still running it may lazy-load; never a page and never anything else.
   */
  async respond(request: { readonly pathname: string; readonly navigate: boolean }): Promise<ReleaseResponse | null> {
    const { active, previous } = await this.#load();
    if (active === null) return null;
    const own = request.pathname.slice(1);
    if (request.navigate) {
      const page = releasePathForRequest(request, active.manifest.files, this.options.rewrites);
      const fallback = Object.hasOwn(active.manifest.files, 'index.html') ? 'index.html' : null;
      return await this.#serve(active, request.pathname, page ?? fallback);
    }
    if (own === RELEASE_MANIFEST_FILE || own === RELEASE_SIGNATURE_FILE || own === active.manifest.worker) return null;
    const path = releasePathForRequest(request, active.manifest.files, this.options.rewrites);
    if (path !== null) return await this.#serve(active, request.pathname, path);
    if (previous !== null && own.startsWith('assets/') && Object.hasOwn(previous.manifest.files, own))
      return await this.#serve(previous, request.pathname, own);
    return null;
  }

  /**
   * The verified bytes of `path`, with the headers `_headers` gives `pathname`. A cached copy is
   * re-hashed first; one that fails is fetched again and, if THAT verifies, repairs the cache. If no
   * verified copy exists the answer is a refusal, never unverified bytes.
   */
  async #serve(release: VerifiedRelease, pathname: string, path: string | null): Promise<ReleaseResponse> {
    const { caches, network, headers } = this.options;
    if (path !== null) {
      const cached = await caches.get(release.cacheName, path);
      if (cached !== null && (await verifyReleaseFile(release.manifest, path, cached)))
        return { status: 200, bytes: cached, headers: releaseHeadersFor(pathname, path, headers) };
      const fresh = await network.get(path);
      if (fresh !== null && (await verifyReleaseFile(release.manifest, path, fresh))) {
        // A deferred file is answered, never kept: the one copy that matters is the speech engine's.
        if (!isDeferredReleaseFile(path)) await caches.put(release.cacheName, path, fresh);
        return { status: 200, bytes: fresh, headers: releaseHeadersFor(pathname, path, headers) };
      }
    }
    return { status: 503, bytes: UNVERIFIABLE_BODY, headers: releaseHeadersFor(pathname, 'unverifiable.txt', headers) };
  }

  /**
   * Whether a worker script at `path` is the worker a verified release names, byte for byte. Asked
   * the moment the browser starts installing a new worker, so it is as quick as it can be: the
   * installed release first, then ONLY the site's current list and signature — never a full update,
   * which a hostile worker would use as time to take over the tab first.
   */
  async isSignedWorker(path: string, script: Uint8Array): Promise<boolean> {
    const hash = await sha256Base64Url(script);
    const names = (manifest: ReleaseManifest): boolean => manifest.worker === path && manifest.files[path] === hash;
    const { chain, active } = await this.#load();
    if (active !== null && names(active.manifest)) return true;
    const candidate = await this.#candidate();
    if (candidate === null) return false;
    const decision = await verifyReleaseManifest(candidate, chain, installedOrder(active), { allowUnsigned: false });
    return decision.accepted && names(decision.manifest);
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
  return { type: 'fy-release-worker-audit', signed: script !== null && (await keeper.isSignedWorker(path, script)) };
};

/** The reply, or `null` for anything a worker did not send. */
export const parseReleaseReply = (data: unknown): ReleaseReplyMessage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { readonly type?: unknown; readonly outcome?: unknown; readonly signed?: unknown };
  if (message.type === 'fy-release-worker-audit' && typeof message.signed === 'boolean')
    return { type: message.type, signed: message.signed };
  if (message.type !== 'fy-release-outcome') return null;
  if (message.outcome === null) return { type: message.type, outcome: null };
  const outcome = ReleaseOutcomeSchema.safeParse(message.outcome);
  return outcome.success ? { type: message.type, outcome: outcome.data } : null;
};
