/**
 * The cryptographic port the session protocol is written against.
 *
 * Nothing here chooses an implementation. The domain states which primitives it needs and in what
 * shape; an adapter binds them to a platform. Two consequences matter: the handshake and record
 * layers are testable without a platform, and a daemon, a browser and a rendezvous can all satisfy
 * the same port from whatever their runtime offers.
 *
 * The primitives are deliberately boring and standard — X25519, Ed25519, HKDF-SHA256, AES-256-GCM —
 * and are composed the way TLS 1.3 composes them: ephemeral key agreement for forward secrecy, a
 * signature over the transcript for identity, and everything after that under keys nobody else can
 * derive. Nothing here is invented.
 */

/**
 * A private key an adapter minted.
 *
 * The domain never inspects one and never serialises one; it hands the same object back to the
 * adapter that produced it. Keeping key material behind a handle is what lets an adapter use
 * non-extractable platform keys.
 */
export interface PrivateKeyHandle {
  readonly algorithm: 'X25519' | 'Ed25519';
}

export interface EphemeralKeyPair {
  /** The raw 32-byte X25519 public key, exactly as it travels on the wire. */
  readonly publicKey: Uint8Array;
  readonly privateKey: PrivateKeyHandle;
}

/** A daemon's durable signing identity, and the fingerprint every peer pins it by. */
export interface DaemonIdentity {
  /** SubjectPublicKeyInfo DER of the Ed25519 public key: the 44 bytes the fingerprint hashes. */
  readonly publicKeySpki: Uint8Array;
  /** `fy_daemon_<base64url sha256 of publicKeySpki>` — the same identifier the pairing QR carries. */
  readonly daemonId: string;
  readonly privateKey: PrivateKeyHandle;
}

export interface RelayCrypto {
  /** Cryptographically secure random bytes, for nonces, session identifiers and ephemeral keys. */
  randomBytes(length: number): Uint8Array;

  sha256(data: Uint8Array): Promise<Uint8Array>;

  generateEphemeralKeyPair(): Promise<EphemeralKeyPair>;

  /**
   * X25519 agreement. Returns null when the peer key is not a usable point, so a caller cannot
   * reach a shared secret it should have refused.
   */
  deriveSharedSecret(privateKey: PrivateKeyHandle, peerPublicKey: Uint8Array): Promise<Uint8Array | null>;

  /** HKDF-SHA256: extract with `salt` over `secret`, then expand `label` to `length` bytes. */
  deriveKey(secret: Uint8Array, salt: Uint8Array, label: string, length: number): Promise<Uint8Array>;

  signEd25519(privateKey: PrivateKeyHandle, message: Uint8Array): Promise<Uint8Array>;

  /** Verify against a SubjectPublicKeyInfo DER key. False for a bad signature and for a bad key. */
  verifyEd25519(publicKeySpki: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>;

  /** AES-256-GCM seal. The tag is appended to the ciphertext, as every platform library does. */
  seal(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;

  /** AES-256-GCM open. Null on any authentication failure — never a partial or unverified result. */
  open(
    key: Uint8Array,
    nonce: Uint8Array,
    associatedData: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null>;
}
