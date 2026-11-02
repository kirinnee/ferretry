import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { documentProblem } from '../../lib/catalog-members/document.ts';
import { CatalogLinkRefusal } from '../../lib/catalog-links/refusal.ts';
import type { LinkKeyVault } from '../../lib/catalog-links/ports.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type { FileSecretKey } from '../secrets/webcrypto-secret-cipher.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const IV_BYTES = 12;

/** `link-keys.json`: AES-256-GCM, the vault's key, each entry bound to its link id. */
const KeysDocumentSchema = z.strictObject({
  v: z.literal(1),
  cipher: z.literal('AES-256-GCM'),
  entries: z.record(z.string(), z.strictObject({ iv: z.string().min(1), ciphertext: z.string().min(1) })),
});
type KeysDocument = z.infer<typeof KeysDocumentSchema>;

type CryptoBytes = Uint8Array<ArrayBuffer>;

const owned = (source: Uint8Array): CryptoBytes => {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
};
const utf8 = (value: string): CryptoBytes => owned(new TextEncoder().encode(value));
const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const decode = (value: string): CryptoBytes => owned(Buffer.from(value, 'base64'));

/**
 * The SEVENTH holder of vault-key-protected material (docs/secrets.md): the key of each PUBLIC link this machine
 * has on, sealed so the owner can Copy the link again. It is the only place a link key is ever written, and a
 * one-time link's key is not written at all.
 *
 * It shares the vault's own key file, so the honest threat model is the vault's: this protects the ciphertext
 * against travelling WITHOUT its key (a backup of `state/` alone), and against nothing else. Each entry is bound
 * to its link id as additional authenticated data, so moving the sealed bytes under another link id fails the open
 * rather than handing out the wrong key.
 *
 * NOTHING HERE PUTS A KEY IN AN ERROR. A failed open says that it failed and names the link, not the key.
 */
export class FileLinkKeyVault implements LinkKeyVault {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly keys: FileSecretKey,
    private readonly randomIv: () => Uint8Array = () => randomBytes(IV_BYTES),
  ) {}

  async put(linkId: string, key: string): Promise<void> {
    const document = await this.#read();
    const cryptoKey = await this.#import(await this.keys.ensure());
    const iv = owned(this.randomIv());
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.#aad(linkId) },
      cryptoKey,
      utf8(key),
    );
    await this.#write({
      ...document,
      entries: { ...document.entries, [linkId]: { iv: encode(iv), ciphertext: encode(new Uint8Array(sealed)) } },
    });
  }

  async open(linkId: string): Promise<string | undefined> {
    const sealed = (await this.#read()).entries[linkId];
    if (sealed === undefined) return undefined;
    const material = await this.keys.read();
    if (material === undefined)
      throw new CatalogLinkRefusal('links_store_damaged', 'The vault key is gone, so no link key can be opened.');
    try {
      const opened = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(sealed.iv), additionalData: this.#aad(linkId) },
        await this.#import(material),
        decode(sealed.ciphertext),
      );
      return new TextDecoder().decode(opened);
    } catch {
      throw new CatalogLinkRefusal(
        'links_store_damaged',
        `The stored key of link ${linkId} did not authenticate under this vault key.`,
      );
    }
  }

  async forget(linkId: string): Promise<void> {
    const document = await this.#read();
    if (document.entries[linkId] === undefined) return;
    const { [linkId]: _forgotten, ...entries } = document.entries;
    await this.#write({ ...document, entries });
  }

  #aad(linkId: string): CryptoBytes {
    return utf8(`catalog-link:${linkId}`);
  }

  async #import(material: CryptoBytes): Promise<CryptoKey> {
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async #read(): Promise<KeysDocument> {
    const raw = await this.files.readText(this.paths.catalogLinkKeys);
    if (raw === undefined) return { v: 1, cipher: 'AES-256-GCM', entries: {} };
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw this.#damaged('it is not JSON');
    }
    const parsed = KeysDocumentSchema.safeParse(decoded);
    if (!parsed.success) throw this.#damaged(documentProblem(parsed) ?? 'it is malformed');
    return parsed.data;
  }

  async #write(document: KeysDocument): Promise<void> {
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(this.paths.catalogLinkKeys, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.paths.catalogLinkKeys, FILE_MODE);
  }

  #damaged(why: string): CatalogLinkRefusal {
    return new CatalogLinkRefusal('links_store_damaged', `link-keys.json cannot be read: ${why}. Nothing was changed.`);
  }
}
