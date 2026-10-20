/**
 * Copying secrets from one machine to another WITHOUT a value ever reaching a caller.
 *
 * READ `docs/secrets.md` ("Copying secrets to another machine") FOR THE THREAT MODEL. In one paragraph:
 * the TARGET opens an import — a one-time X25519 key pair whose public half it signs with its own daemon
 * identity — and the SOURCE, after a passkey confirmation for this act alone, seals the chosen values to
 * that key (X25519 → HKDF-SHA256 → AES-256-GCM, bound to both daemon ids, the import id and the expiry).
 * The browser that carries the bundle between them holds neither private key, so what it relays is
 * opaque to it. The target opens the bundle ONCE, files the values in its own store, and forgets the
 * import whether or not it opened.
 *
 * TWO CLASSES ON PURPOSE, one per end, for the reason `vault.ts` splits its two:
 *
 * - `SecretImportService` (the target) is handed a `SecretDirectory`, which can WRITE a value and never
 *   read one. It holds the import's private key in memory and nowhere else.
 * - `SecretExportService` (the source) is handed a `SecretVault`: it is the SIXTH holder, and like the
 *   other five it never returns what it read. Its only output is ciphertext sealed to another machine's
 *   key, which no caller of this daemon can open.
 *
 * WHAT IT DOES NOT PROVE: that the target is a machine the OWNER owns. The offer proves only that whoever
 * holds the key the target's daemon id fingerprints asked for these values. A caller who may confirm this
 * act could hand the source an offer from an identity of their own — but that caller already holds
 * `secrets.use` on the source and could run `echo $KEY` through it. The source's security log records the
 * import id, and the target's records the same id, so a copy that went somewhere unexpected is visible.
 */

import {
  type DaemonId,
  MAX_SECRETS_PER_DAEMON,
  SECRET_CLONE_SCHEMA_VERSION,
  SECRET_IMPORT_TTL_SECONDS,
  type SealedSecretBundle,
  type SecretCloneRefusal,
  type SecretExportRequest,
  type SecretExportResponse,
  type SecretImportId,
  type SecretImportOffer,
  type SecretImportResult,
  type SecretName,
  SecretNameSchema,
  SecretValueSchema,
} from '@ferretry/protocol';
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  concatBytes,
  type DaemonIdentity,
  ED25519_SIGNATURE_BYTES,
  fromBase64Url,
  fromBase64UrlFixed,
  lengthPrefixed,
  type PrivateKeyHandle,
  publicKeyMatchesDaemonId,
  type RelayCrypto,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  X25519_PUBLIC_KEY_BYTES,
} from '@ferretry/relay';
import { z } from 'zod';
import type { ClockPort } from '../ports.ts';
import { SecretStoreError, UnknownSecretError } from './types.ts';
import type { SecretDirectory, SecretVault } from './vault.ts';

/** Domain separation: an offer signature can never be replayed as a relay claim, or the reverse. */
const OFFER_SIGNATURE_LABEL = 'ferretry-secret-import-offer-v1';
/** The authenticated header of a bundle. */
const BUNDLE_HEADER_LABEL = 'ferretry-secret-clone-bundle-v1';
/** The HKDF label the bundle key is expanded under. */
const BUNDLE_KEY_LABEL = 'ferretry-secret-clone-key-v1';

/** 128 random bits per import id. */
const IMPORT_ID_BYTES = 16;
const IMPORT_ID_PREFIX = 'fy_secret_import_';

/** How many imports may be open at once. A forgotten one costs memory until it expires; this bounds it. */
export const MAX_OPEN_SECRET_IMPORTS = 8;

/**
 * How far apart two machines' clocks may be before an offer reads as expired or as overlong.
 *
 * The SOURCE checks the target's expiry against its own clock, so a strict comparison would refuse a
 * perfectly good offer from a machine a few seconds ahead. The binding that matters is the target's own,
 * which reads one clock and allows nothing.
 */
const CLOCK_SKEW_MS = 60_000;

const TTL_MS = SECRET_IMPORT_TTL_SECONDS * 1000;

/** A clone step that refused, carrying the closed reason a client words. */
export class SecretCloneError extends Error {
  constructor(
    readonly refusal: SecretCloneRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'SecretCloneError';
  }
}

/** This daemon's own identity, read when a clone needs it. `undefined` when it cannot be read. */
export interface SecretCloneIdentitySource {
  load(): Promise<DaemonIdentity | undefined>;
}

/** What a sealed bundle opens to. Values exist only between `seal` and `open`, never on a wire in clear. */
const BundlePlaintextSchema = z.strictObject({
  entries: z
    .array(z.tuple([SecretNameSchema, SecretValueSchema]))
    .min(1)
    .max(MAX_SECRETS_PER_DAEMON),
});

/** The bytes an offer's signature covers. Length-prefixed, so no field's end can become the next one's start. */
function offerSignedBytes(offer: Omit<SecretImportOffer, 'signature'>): Uint8Array {
  return concatBytes(
    [
      OFFER_SIGNATURE_LABEL,
      String(offer.v),
      offer.importId,
      offer.daemonId,
      offer.identityKey,
      offer.publicKey,
      offer.expiresAt,
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}

/** The bundle header the AES-GCM tag authenticates: everything but the nonce and the ciphertext. */
function bundleHeaderBytes(bundle: Omit<SealedSecretBundle, 'nonce' | 'ciphertext'>): Uint8Array {
  return concatBytes(
    [
      BUNDLE_HEADER_LABEL,
      String(bundle.v),
      bundle.importId,
      bundle.sourceDaemonId,
      bundle.targetDaemonId,
      bundle.expiresAt,
      bundle.names.join('\n'),
      bundle.ephemeralKey,
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}

/** The one key both ends derive for one import: X25519, then HKDF salted with the import id. */
async function bundleKey(
  crypto: RelayCrypto,
  privateKey: PrivateKeyHandle,
  peerPublicKey: Uint8Array,
  importId: SecretImportId,
): Promise<Uint8Array | null> {
  const shared = await crypto.deriveSharedSecret(privateKey, peerPublicKey);
  if (shared === null) return null;
  return await crypto.deriveKey(shared, utf8Bytes(importId), BUNDLE_KEY_LABEL, AEAD_KEY_BYTES);
}

async function ownIdentity(source: SecretCloneIdentitySource): Promise<DaemonIdentity> {
  const identity = await source.load();
  if (identity === undefined)
    throw new SecretCloneError(
      'identity_unavailable',
      'this machine cannot read its own identity, so it cannot take part in copying secrets',
    );
  return identity;
}

/** Everything the TARGET needs. */
export interface SecretImportDependencies {
  readonly crypto: RelayCrypto;
  readonly identity: SecretCloneIdentitySource;
  /** Write-only: it can file a value and never hand one back. */
  readonly directory: SecretDirectory;
  readonly clock: ClockPort;
}

interface OpenImport {
  readonly offer: SecretImportOffer;
  /** The import's private half. It lives here, in memory, and dies with the import or with this daemon. */
  readonly privateKey: PrivateKeyHandle;
  readonly expiresAtMs: number;
}

/**
 * The TARGET's half: open an import, accept one bundle for it.
 *
 * IT HOLDS STATE, deliberately and only in memory, like the pairing service's live codes: an open import
 * is a private key with a five-minute life, and a key that outlived a restart on disk would be a key in
 * a backup. A restart therefore forgets every open import, which fails closed — the person opens another.
 */
export class SecretImportService {
  readonly #open = new Map<SecretImportId, OpenImport>();
  /** Imports already used, until they would have expired — so a replay is told so, not "unknown". */
  readonly #spent = new Map<SecretImportId, number>();

  constructor(private readonly deps: SecretImportDependencies) {}

  /** Opens one import: a fresh key pair, signed by this machine's identity. */
  async open(): Promise<SecretImportOffer> {
    const identity = await ownIdentity(this.deps.identity);
    const nowMs = Date.parse(this.deps.clock.now());
    this.#prune(nowMs);
    while (this.#open.size >= MAX_OPEN_SECRET_IMPORTS) {
      const oldest = this.#open.keys().next().value as SecretImportId;
      this.#open.delete(oldest);
    }
    const keys = await this.deps.crypto.generateEphemeralKeyPair();
    const expiresAtMs = nowMs + TTL_MS;
    const unsigned = {
      v: SECRET_CLONE_SCHEMA_VERSION,
      importId: `${IMPORT_ID_PREFIX}${toBase64Url(this.deps.crypto.randomBytes(IMPORT_ID_BYTES))}`,
      daemonId: identity.daemonId,
      identityKey: toBase64Url(identity.publicKeySpki),
      publicKey: toBase64Url(keys.publicKey),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const signature = await this.deps.crypto.signEd25519(identity.privateKey, offerSignedBytes(unsigned));
    const offer: SecretImportOffer = { ...unsigned, signature: toBase64Url(signature) };
    this.#open.set(offer.importId, { offer, privateKey: keys.privateKey, expiresAtMs });
    return offer;
  }

  /**
   * Opens a bundle for one import and files what it holds.
   *
   * THE IMPORT IS SPENT BY THE ATTEMPT, not by its success: a target that let a tampered bundle be
   * retried against the same key would be an oracle somebody could query. Whatever happens below the
   * lookup, this import id is never accepted again.
   */
  async complete(importId: SecretImportId, bundle: SealedSecretBundle): Promise<SecretImportResult> {
    const nowMs = Date.parse(this.deps.clock.now());
    if (this.#spent.has(importId))
      throw new SecretCloneError('import_spent', 'this import was already used; open a new one to copy again');
    // Looked up BEFORE the sweep, so an import that has just run out is told so rather than "unknown".
    const open = this.#open.get(importId);
    this.#prune(nowMs);
    if (open === undefined)
      throw new SecretCloneError(
        'import_unknown',
        'this machine has no such import open: it timed out, or this machine restarted; open a new one',
      );
    this.#open.delete(importId);
    this.#spent.set(importId, open.expiresAtMs);
    if (open.expiresAtMs <= nowMs)
      throw new SecretCloneError('offer_expired', 'this import timed out before the secrets arrived; open a new one');
    const entries = await this.#openBundle(open, bundle);
    return await this.#file(importId, bundle.sourceDaemonId, entries);
  }

  async #openBundle(open: OpenImport, bundle: SealedSecretBundle): Promise<readonly [SecretName, string][]> {
    const { offer } = open;
    if (
      bundle.importId !== offer.importId ||
      bundle.targetDaemonId !== offer.daemonId ||
      bundle.expiresAt !== offer.expiresAt
    )
      throw new SecretCloneError('bundle_invalid', 'this bundle was sealed for another import or another machine');
    if (bundle.sourceDaemonId === offer.daemonId)
      throw new SecretCloneError('same_machine', 'a machine cannot copy secrets to itself');
    const ephemeralKey = fromBase64UrlFixed(bundle.ephemeralKey, X25519_PUBLIC_KEY_BYTES);
    const nonce = fromBase64UrlFixed(bundle.nonce, AEAD_NONCE_BYTES);
    const ciphertext = fromBase64Url(bundle.ciphertext);
    const key =
      ephemeralKey === null ? null : await bundleKey(this.deps.crypto, open.privateKey, ephemeralKey, offer.importId);
    const plaintext =
      key === null || nonce === null || ciphertext === null
        ? null
        : await this.deps.crypto.open(key, nonce, bundleHeaderBytes(bundle), ciphertext);
    const text = plaintext === null ? null : utf8Text(plaintext);
    const parsed = text === null ? undefined : BundlePlaintextSchema.safeParse(parseJson(text));
    if (parsed === undefined || !parsed.success)
      throw new SecretCloneError('bundle_invalid', 'this bundle does not open for this import; nothing was copied');
    const names = parsed.data.entries.map(([name]) => name);
    if (names.join('\n') !== bundle.names.join('\n'))
      throw new SecretCloneError(
        'bundle_invalid',
        'this bundle does not hold the secrets it names; nothing was copied',
      );
    return parsed.data.entries;
  }

  /** Files every value, after checking ALL of them fit — a half-copied set is worse than none. */
  async #file(
    importId: SecretImportId,
    sourceDaemonId: DaemonId,
    entries: readonly [SecretName, string][],
  ): Promise<SecretImportResult> {
    const held = new Set((await this.deps.directory.list()).map(secret => secret.name));
    const added = entries.filter(([name]) => !held.has(name)).length;
    if (held.size + added > MAX_SECRETS_PER_DAEMON)
      throw new SecretStoreError(
        'full',
        `copying these would take this machine past ${MAX_SECRETS_PER_DAEMON} secrets; nothing was copied`,
      );
    for (const [name, value] of entries) await this.deps.directory.put(name, value);
    const imported = entries.map(([name]) => name);
    return { importId, sourceDaemonId, imported, replaced: imported.filter(name => held.has(name)) };
  }

  /** Forgets expired imports, and spent ids that could no longer be presented. */
  #prune(nowMs: number): void {
    for (const [id, open] of this.#open) if (open.expiresAtMs <= nowMs) this.#open.delete(id);
    for (const [id, expiresAtMs] of this.#spent) if (expiresAtMs <= nowMs) this.#spent.delete(id);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Everything the SOURCE needs. */
export interface SecretExportDependencies {
  readonly crypto: RelayCrypto;
  readonly identity: SecretCloneIdentitySource;
  /** THE SIXTH HOLDER. Read here; what leaves is ciphertext only another machine can open. */
  readonly vault: SecretVault;
  readonly clock: ClockPort;
}

/**
 * The SOURCE's half: check an offer, seal the chosen values to it.
 *
 * Stateless: everything it decides is in the request and the vault. The passkey confirmation that must
 * precede it is the route's to demand (`mounts/secrets.ts`), because the boundary owns the step-up.
 */
export class SecretExportService {
  constructor(private readonly deps: SecretExportDependencies) {}

  async seal(importId: SecretImportId, request: SecretExportRequest): Promise<SecretExportResponse> {
    const { offer, names } = request;
    const identity = await ownIdentity(this.deps.identity);
    if (offer.importId !== importId)
      throw new SecretCloneError('offer_invalid', 'the offer is for another import than the one asked for');
    if (offer.daemonId === identity.daemonId)
      throw new SecretCloneError('same_machine', 'a machine cannot copy secrets to itself');
    const offerKey = await this.#verifiedOfferKey(offer);
    const values = await this.deps.vault.values();
    const missing = names.filter(name => !values.has(name));
    if (missing.length > 0) throw new UnknownSecretError(missing);
    const ephemeral = await this.deps.crypto.generateEphemeralKeyPair();
    const key = await bundleKey(this.deps.crypto, ephemeral.privateKey, offerKey, offer.importId);
    if (key === null) throw new SecretCloneError('offer_invalid', 'the offer carries a key no machine could hold');
    const header = {
      v: SECRET_CLONE_SCHEMA_VERSION,
      importId: offer.importId,
      sourceDaemonId: identity.daemonId,
      targetDaemonId: offer.daemonId,
      expiresAt: offer.expiresAt,
      names,
      ephemeralKey: toBase64Url(ephemeral.publicKey),
    };
    const nonce = this.deps.crypto.randomBytes(AEAD_NONCE_BYTES);
    const plaintext = utf8Bytes(JSON.stringify({ entries: names.map(name => [name, values.get(name)]) }));
    const ciphertext = await this.deps.crypto.seal(key, nonce, bundleHeaderBytes(header), plaintext);
    return {
      bundle: { ...header, nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) },
      names,
    };
  }

  /** The offer's X25519 key, once its signature, fingerprint and expiry hold. */
  async #verifiedOfferKey(offer: SecretImportOffer): Promise<Uint8Array> {
    const nowMs = Date.parse(this.deps.clock.now());
    const expiresAtMs = Date.parse(offer.expiresAt);
    if (expiresAtMs + CLOCK_SKEW_MS <= nowMs)
      throw new SecretCloneError('offer_expired', 'the other machine’s import timed out; open a new one there');
    if (expiresAtMs - nowMs > TTL_MS + CLOCK_SKEW_MS)
      throw new SecretCloneError('offer_invalid', 'the offer claims to stay open longer than any import does');
    const identityKey = fromBase64Url(offer.identityKey);
    const publicKey = fromBase64UrlFixed(offer.publicKey, X25519_PUBLIC_KEY_BYTES);
    const signature = fromBase64UrlFixed(offer.signature, ED25519_SIGNATURE_BYTES);
    const { signature: _signature, ...unsigned } = offer;
    const genuine =
      identityKey !== null &&
      publicKey !== null &&
      signature !== null &&
      (await publicKeyMatchesDaemonId(this.deps.crypto, identityKey, offer.daemonId)) &&
      (await this.deps.crypto.verifyEd25519(identityKey, signature, offerSignedBytes(unsigned)));
    if (!genuine || publicKey === null)
      throw new SecretCloneError('offer_invalid', 'the offer was not signed by the machine it names');
    return publicKey;
  }
}
