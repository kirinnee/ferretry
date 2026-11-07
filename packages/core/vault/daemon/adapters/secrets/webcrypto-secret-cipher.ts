import {
  SECRET_CIPHER_ALGORITHM,
  SECRET_IV_BYTES as IV_BYTES,
  type SecretName,
  VAULT_KEY_BYTES as KEY_BYTES,
} from '../../../contract/index.ts';
import { SecretStoreError, type SecretCipherPort } from '../../lib/secrets/types.ts';
import type { SealedFiles } from './kernel-sealed-files.ts';

/** AES-256-GCM, from the contract (spine D16). Bun ships WebCrypto, so this needs no dependency. */
export { SECRET_CIPHER_ALGORITHM };

/** Cryptographically secure random bytes (today's `node:crypto` `randomBytes`; the same source in Bun). */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

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
    private readonly files: SealedFiles,
    private readonly mint: () => Uint8Array = () => owned(randomBytes(KEY_BYTES)),
  ) {}

  /** The key, minting one the first time a secret is written. */
  async ensure(): Promise<CryptoBytes> {
    const existing = await this.read();
    if (existing !== undefined) return existing;
    const minted = this.mint();
    // The kernel writes a `secret` file atomically and `0600` (today's `writeTextAtomic` + `setMode`).
    await this.files.writeText('key', `${encode(minted)}\n`);
    return owned(minted);
  }

  /**
   * The key, or nothing when the file is absent.
   *
   * A file that is present and unusable RAISES: a truncated or corrupted key silently treated as
   * absent would mint a fresh one and orphan every secret already sealed under the old one.
   */
  async read(): Promise<CryptoBytes | undefined> {
    const raw = (await this.files.readText('key'))?.trim();
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

  /**
   * The key is read and imported once for the whole vault rather than once per entry. It lives only as
   * long as this call, exactly as it did per entry: nothing here outlives the open.
   */
  async openAll(
    entries: Readonly<Record<SecretName, { readonly iv: string; readonly ciphertext: string }>>,
  ): Promise<ReadonlyMap<SecretName, string>> {
    const opened = new Map<SecretName, string>();
    const names = Object.keys(entries);
    const first = names[0];
    if (first === undefined) return opened;
    const key = await this.#key(first);
    for (const name of names) {
      const sealed = entries[name];
      if (sealed !== undefined) opened.set(name, await this.#openWith(key, name, sealed));
    }
    return opened;
  }

  /** The key, imported; `name` is only what the refusal names when the key file is gone. */
  async #key(name: SecretName): Promise<CryptoKey> {
    const material = await this.keys.read();
    if (material === undefined)
      throw new SecretStoreError('key_missing', `the vault key is gone, so ${name} cannot be opened`);
    return await this.importKey(material);
  }

  async #openWith(
    key: CryptoKey,
    name: SecretName,
    sealed: { readonly iv: string; readonly ciphertext: string },
  ): Promise<string> {
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
