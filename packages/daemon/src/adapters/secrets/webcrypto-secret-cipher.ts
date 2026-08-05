import { randomBytes } from 'node:crypto';
import type { SecretName } from '@ferretry/protocol';
import { type FileSystemPort, SecretStoreError, type SecretCipherPort } from '../../lib/index.ts';

/** AES-256-GCM. Bun ships WebCrypto, so this needs no dependency and no vendored implementation. */
export const SECRET_CIPHER_ALGORITHM = 'AES-256-GCM';

/** 96-bit nonce: the size AES-GCM is specified for, and the only one where random generation is safe
 *  at the volume a secret store writes. */
const IV_BYTES = 12;

const KEY_BYTES = 32;

const SECRET_MODE = 0o600;

/**
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`, so every buffer handed to it is copied
 * into an array over a plain `ArrayBuffer`. A cast would satisfy the compiler and say something
 * untrue about where the bytes live.
 */
type CryptoBytes = Uint8Array<ArrayBuffer>;

function owned(source: Uint8Array): CryptoBytes {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decode(value: string, field: string): CryptoBytes {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new SecretStoreError('undecipherable', `a sealed secret has an empty ${field}`);
  return owned(bytes);
}

function utf8(value: string): CryptoBytes {
  return owned(new TextEncoder().encode(value));
}

/**
 * The vault key, held in its own file in the state home.
 *
 * MINTED, NEVER CONFIGURED — for the same reason the API token is: a key in a configuration file is
 * a key in a backup, in a dotfile repository and in a screen share. It is created on the first write
 * and read on every open.
 *
 * Read the honest threat model on `FileSecretDocumentStore`. In short: this key protects the
 * ciphertext against travelling WITHOUT it, and against nothing else.
 */
export class FileSecretKey {
  constructor(
    private readonly path: string,
    private readonly files: FileSystemPort,
    private readonly mint: () => Uint8Array = () => owned(randomBytes(KEY_BYTES)),
  ) {}

  /** The key, minting one the first time a secret is written. */
  async ensure(): Promise<CryptoBytes> {
    const existing = await this.read();
    if (existing !== undefined) return existing;
    const minted = this.mint();
    await this.files.writeTextAtomic(this.path, `${encode(minted)}\n`);
    await this.files.setMode(this.path, SECRET_MODE);
    return owned(minted);
  }

  /**
   * The key, or nothing when the file is absent.
   *
   * A file that is present and unusable RAISES: a truncated or corrupted key silently treated as
   * absent would mint a fresh one and orphan every secret already sealed under the old one.
   */
  async read(): Promise<CryptoBytes | undefined> {
    const raw = (await this.files.readText(this.path))?.trim();
    if (raw === undefined || raw === '') return undefined;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== KEY_BYTES)
      throw new SecretStoreError('undecipherable', 'the vault key file does not hold a 32-byte key');
    return owned(bytes);
  }
}

/**
 * Sealing and opening with AES-256-GCM, the secret's NAME as additional authenticated data.
 *
 * Binding the name means an entry cannot be relabelled by editing the document: moving the sealed
 * bytes of `STAGING_KEY` under the name `PRODUCTION_KEY` makes the open fail rather than handing a
 * staging credential to something that asked for production.
 *
 * NOTHING HERE EVER PUTS A VALUE IN AN ERROR. A failed open reports that it failed and names the
 * secret, because the name is not the secret and the person needs to know which entry is broken.
 */
export class WebCryptoSecretCipher implements SecretCipherPort {
  readonly algorithm = SECRET_CIPHER_ALGORITHM;

  constructor(
    private readonly keys: FileSecretKey,
    private readonly randomIv: () => Uint8Array = () => owned(randomBytes(IV_BYTES)),
  ) {}

  async seal(name: SecretName, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }> {
    const key = await this.importKey(await this.keys.ensure());
    const iv = owned(this.randomIv());
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(name) },
      key,
      utf8(plaintext),
    );
    return { iv: encode(iv), ciphertext: encode(new Uint8Array(sealed)) };
  }

  async open(name: SecretName, sealed: { readonly iv: string; readonly ciphertext: string }): Promise<string> {
    const material = await this.keys.read();
    if (material === undefined)
      throw new SecretStoreError('key_missing', `the vault key is gone, so ${name} cannot be opened`);
    const key = await this.importKey(material);
    try {
      const opened = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decode(sealed.iv, 'iv'),
          additionalData: utf8(name),
        },
        key,
        decode(sealed.ciphertext, 'ciphertext'),
      );
      return new TextDecoder().decode(opened);
    } catch (error) {
      // A GCM failure is authentication, not a decode: the key is wrong, or the entry was edited. The
      // cause is deliberately not chained — a WebCrypto error carries no value, but chaining a cause
      // through a boundary whose whole point is that nothing leaks is a habit worth not having.
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError('undecipherable', `the stored secret ${name} did not authenticate under this key`);
    }
  }

  private async importKey(material: CryptoBytes): Promise<CryptoKey> {
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
}
