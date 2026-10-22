/**
 * THE SIGNED RELEASE LIST — the file a Pages deploy carries so an installed app can tell a real
 * Ferretry release from anything else the same address might serve.
 *
 * `release-manifest.json` names every file the site serves and the SHA-256 of its exact bytes.
 * `release-manifest.sig` is an Ed25519 signature over the manifest's exact bytes. CI signs; the
 * service worker verifies (`release-verification.ts`) and fills its cache only with bytes whose hash
 * the signed list names (`release-keeper.ts`). The contract, the key's custody and what this does
 * NOT protect against are `docs/pwa-release-signing.md` — read that before describing it.
 *
 * Everything here is pure: it is shared by the build script that writes the list, the CI step that
 * signs it, the worker that checks it and the page that audits a replaced worker, so all four agree
 * on one spelling of every field.
 */

import { z } from 'zod';

/** The list itself, at the site root. */
export const RELEASE_MANIFEST_FILE = 'release-manifest.json';
/** The signature over the list's exact bytes, beside it. */
export const RELEASE_SIGNATURE_FILE = 'release-manifest.sig';
/**
 * The service worker's release name, so its script is `/sw.verified.js`
 * (`hooks/use-service-worker-update.ts` builds the URL).
 *
 * ONE FIXED URL, NOT ONE PER DEPLOY. The worker does not change when a release does — it fetches,
 * verifies and swaps releases itself — so a per-deploy URL would only make every release install a
 * new worker the reader has to reload into a second time. The browser still re-checks this URL byte
 * for byte, so a worker whose code changed is installed, and audited, like any other.
 */
export const RELEASE_WORKER_RELEASE = 'verified';
/** The worker every release lists in `worker` (and in `files`), which is what a page audits against. */
export const RELEASE_WORKER_FILE = `sw.${RELEASE_WORKER_RELEASE}.js`;
const WORKER_PATH_PATTERN = /^sw\.[A-Za-z0-9._-]+\.js$/u;

/**
 * The whole content of `release-manifest.sig` in a build that had no signing key: a local build, a
 * pull request's CI build. It is a marker rather than an absent file so "unsigned" is a decision the
 * build made out loud, never a missing upload. Only a loopback origin may run such a build without a
 * refusal; the deploy workflow refuses to publish one at all.
 */
export const UNSIGNED_RELEASE_SIGNATURE = 'unsigned';

/**
 * Files in `dist/` the list never names. `_headers` and `_redirects` are Pages configuration and are
 * never served as bytes (asking for one answers the app's fallback page, which would read as a hash
 * mismatch and refuse every release); the list and its signature cannot name themselves.
 */
export const UNLISTED_RELEASE_FILES: readonly string[] = [
  '_headers',
  '_redirects',
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
];

/**
 * Files a release LISTS AND VERIFIES but does not download when it installs: the ONNX Runtime
 * WebAssembly binary on-device dictation runs on (~12 MB), which only someone who installs Parakeet
 * ever uses. Every other file is fetched by every installed copy of the app, so this one would cost
 * every visitor 12 MB for a feature most never turn on. The sherpa-onnx binary
 * (`assets/asr-<hash>.wasm`, ~14 MB, `lib/stt/sherpa-models.ts`) is deferred for the same reason.
 * Deferring it changes WHEN it is fetched, never whether it is checked: the keeper still answers a request for it only with bytes that hash to the
 * signed list, it just fetches them on that request instead of at install, and does not keep a second
 * copy (`lib/stt/parakeet-store.ts` keeps the one the speech engine uses).
 */
const DEFERRED_RELEASE_FILE = /^assets\/(?:ort-wasm-simd-threaded|asr)[A-Za-z0-9._-]*\.wasm$/u;
/** Vosk's WebAssembly runtime (~3 MB), deferred for the same reason: only a Vosk install fetches it. */
const DEFERRED_VOSK_RUNTIME = /^assets\/vosk-[A-Za-z0-9_-]+\.wasm$/u;

/** Whether the keeper leaves this listed file to be fetched, verified, when something asks for it. */
export const isDeferredReleaseFile = (path: string): boolean =>
  DEFERRED_RELEASE_FILE.test(path) || DEFERRED_VOSK_RUNTIME.test(path);

const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
/** A relative site path: no leading slash, no `.`/`..` segment, nothing a URL would re-interpret. */
const RELEASE_PATH_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, 'u');
/** 32 bytes of SHA-256, unpadded base64url. */
const SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
/** A 44-byte Ed25519 SubjectPublicKeyInfo, unpadded base64url. */
const SPKI_PATTERN = /^[A-Za-z0-9_-]{59}$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const ReleaseKeySchema = z.string().regex(SPKI_PATTERN);

export const ReleaseManifestSchema = z
  .strictObject({
    version: z.string().regex(VERSION_PATTERN),
    commit: z.string().regex(/^[0-9a-f]{7,64}$/u),
    /**
     * What orders releases: a counter CI owns and only ever raises (`pwa-pages.yaml` passes the
     * workflow run number). Never the clock, which is whatever whoever made the commit said it was.
     */
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** When the commit was made. Informational only: it orders nothing. */
    createdAt: z.iso.datetime(),
    worker: z.string().regex(WORKER_PATH_PATTERN),
    files: z.record(z.string().regex(RELEASE_PATH_PATTERN), z.string().regex(SHA256_PATTERN)),
    /** The key the NEXT release will be signed with, announced under the current one. */
    nextKey: ReleaseKeySchema.optional(),
  })
  .refine(manifest => Object.hasOwn(manifest.files, manifest.worker), 'a release must list its service worker')
  .refine(
    manifest => UNLISTED_RELEASE_FILES.every(path => !Object.hasOwn(manifest.files, path)),
    'a release cannot list a file the site never serves',
  );
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/**
 * How a candidate release stands against the installed one. Only the CI-owned `sequence` decides:
 * Pages deploys every push to `main`, so many deploys share a version, and a commit's time is
 * whatever its author's clock said. Two releases with the same sequence and DIFFERENT commits are
 * not "the same release" — one of them is a replay — so that answers `older` too.
 */
export const releaseStanding = (
  candidate: Pick<ReleaseManifest, 'sequence' | 'commit'>,
  installed: Pick<ReleaseManifest, 'sequence' | 'commit'>,
): 'newer' | 'same' | 'older' => {
  if (candidate.sequence > installed.sequence) return 'newer';
  return candidate.sequence === installed.sequence && candidate.commit === installed.commit ? 'same' : 'older';
};

/**
 * The one spelling the build writes: two-space JSON, files in code-unit order, a closing newline.
 * The signature covers whatever bytes were written, so this is about reproducible builds, not about
 * verification — a verifier never re-serialises.
 */
export const serializeReleaseManifest = (manifest: ReleaseManifest): string => {
  const files = Object.fromEntries(
    Object.keys(manifest.files)
      .sort()
      .map(path => [path, manifest.files[path]]),
  );
  const ordered = {
    version: manifest.version,
    commit: manifest.commit,
    sequence: manifest.sequence,
    createdAt: manifest.createdAt,
    worker: manifest.worker,
    files,
    ...(manifest.nextKey === undefined ? {} : { nextKey: manifest.nextKey }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

/** The list, or `null` for anything that is not exactly a valid one. */
export const parseReleaseManifest = (bytes: Uint8Array): ReleaseManifest | null => {
  try {
    const parsed = ReleaseManifestSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/* ---------- bytes ----------------------------------------------------------- */

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Strict unpadded base64url: anything that does not round-trip is `null`. */
export const fromBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return toBase64Url(bytes) === text ? bytes : null;
};

/* ---------- the signature file -------------------------------------------- */

export type ReleaseSignature =
  | { readonly kind: 'unsigned' }
  | {
      readonly kind: 'signed';
      /** base64url SHA-256 of the signing key's SPKI, so a verifier can say "unknown key" honestly. */
      readonly keyFingerprint: string;
      readonly signature: Uint8Array;
    };

/** `<key fingerprint>.<signature>`, both unpadded base64url — `.` is outside that alphabet. */
export const formatReleaseSignature = (keyFingerprint: string, signature: Uint8Array): string =>
  `${keyFingerprint}.${toBase64Url(signature)}\n`;

export const parseReleaseSignature = (text: string): ReleaseSignature | null => {
  const trimmed = text.trim();
  if (trimmed === UNSIGNED_RELEASE_SIGNATURE) return { kind: 'unsigned' };
  const [keyFingerprint, encoded, ...rest] = trimmed.split('.');
  if (rest.length > 0 || keyFingerprint === undefined || !SHA256_PATTERN.test(keyFingerprint)) return null;
  const signature = fromBase64Url(encoded ?? '');
  return signature?.length === 64 ? { kind: 'signed', keyFingerprint, signature } : null;
};

/* ---------- the committed public key -------------------------------------- */

/** The fixed DER header of every Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow it. */
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

/**
 * `packages/pwa/release-signing-key.pub` — a PEM `PUBLIC KEY` block, as `openssl pkey -pubout`
 * writes it — as the SPKI base64url the list and the worker use. `null` for anything that is not
 * exactly one Ed25519 key.
 */
export const releaseKeyFromPem = (pem: string): string | null => {
  const match = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PUBLIC KEY-----\n?$/u.exec(
    pem.replaceAll('\r\n', '\n').trim(),
  );
  if (match === null) return null;
  const bytes = Uint8Array.from(atob((match[1] ?? '').replaceAll('\n', '')), character => character.charCodeAt(0));
  if (bytes.length !== 44 || ED25519_SPKI_PREFIX.some((byte, index) => bytes[index] !== byte)) return null;
  return toBase64Url(bytes);
};

/* ---------- which listed file answers a request ---------------------------- */

/** One `200` rewrite from `public/_redirects`: `from` may end in `/*`. */
export interface ReleaseRewrite {
  readonly from: string;
  readonly to: string;
}

/**
 * The rewrites in a Pages `_redirects` file, in order. Only `200` rules are rewrites — a `301`/`302`
 * is a redirect the browser follows itself. The worker is BUILT with these so the file Pages reads
 * stays the only place the app's routes are written down.
 */
export const parseReleaseRewrites = (text: string): readonly ReleaseRewrite[] =>
  text.split('\n').flatMap(line => {
    const [from, to, status] = line.trim().split(/\s+/u);
    return from !== undefined && to !== undefined && status === '200' && from.startsWith('/') ? [{ from, to }] : [];
  });

const matchesRewrite = (pathname: string, from: string): boolean =>
  from.endsWith('/*') ? pathname.startsWith(from.slice(0, -1)) : pathname === from;

export interface ReleaseRequest {
  readonly pathname: string;
  /** A page load, which may be answered by a rewrite; a subresource never is. */
  readonly navigate: boolean;
}

/**
 * The listed file that answers a same-origin request, or `null` for "not part of this release" —
 * which `ReleaseKeeper.respond` answers with the release's own shell for a page load, and leaves to
 * the network otherwise.
 */
export const releasePathForRequest = (
  request: ReleaseRequest,
  files: Readonly<Record<string, string>>,
  rewrites: readonly ReleaseRewrite[],
): string | null => {
  const listed = (path: string): string | null => (Object.hasOwn(files, path) ? path : null);
  const direct = request.pathname.slice(1);
  const exact = listed(request.pathname.endsWith('/') ? `${direct}index.html` : direct);
  if (exact !== null || !request.navigate) return exact;
  const directory = listed(`${direct}/index.html`);
  if (directory !== null) return directory;
  const rewrite = rewrites.find(rule => matchesRewrite(request.pathname, rule.from));
  return rewrite === undefined ? null : listed(rewrite.to.slice(1));
};
