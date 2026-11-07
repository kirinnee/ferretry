import type { Clock, StatePort } from '@ferretry/kernel/contract';
import {
  SECRET_CIPHER_ALGORITHM,
  SECRET_IV_BYTES,
  type SealedDocument,
  type SealedDocumentDef,
  type SealedDocumentHandle,
  SealedDocumentSchema,
  type SealedDocumentsApi,
  type SealedEntry,
  type SealedName,
  SealedNameSchema,
} from '../../../contract/index.ts';
import { SecretStoreError } from '../../lib/secrets/types.ts';
import type { FileSecretKey } from './webcrypto-secret-cipher.ts';

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
 * The sealed-document port (contract change C) over the CALLER's own state port and the vault's own key.
 *
 * Copied from today's two holders of this shape: `FileLinkKeyVault` (seal and open with the vault key straight from
 * WebCrypto, an AAD prefix, entries without instants) and `SecretDirectory`/`FileSecretDocumentStore` over a second
 * document (`mcp-oauth-secrets.json`, `login-secrets.json`: the name as AAD, `createdAt` kept across a replacement,
 * `updatedAt` moved). The bytes are those: AES-256-GCM, a random 96-bit IV, base64 fields, `JSON.stringify(…, 2)` and
 * a newline, `0600`.
 *
 * The caller never holds the key: it is read here, from `state/vault/vault.key`, for the length of one call. The
 * document rests in the caller's `state/<plugin>/`, through the port the kernel rooted there, so a handle can only
 * ever reach its own plugin's files. NOTHING HERE LOGS, and no failure names a value: a refusal names the document
 * and the entry, never what is sealed under it.
 */
export class KernelSealedDocuments implements SealedDocumentsApi {
  /** One write at a time per (caller folder, document): today's `inTurn`, keyed by the caller's own port. */
  readonly #turns = new WeakMap<StatePort, Map<string, Promise<unknown>>>();

  constructor(
    private readonly keys: FileSecretKey,
    private readonly clock: Pick<Clock, 'now'>,
    private readonly randomIv: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(SECRET_IV_BYTES)),
  ) {}

  open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    if (document.kind !== 'sealed-document' || document.state.store !== 'secret')
      throw new TypeError(`sealed document ${document.state.name} is not declared with store: 'secret'`);
    const label = document.state.path;
    const aad = (name: SealedName): CryptoBytes => utf8(`${document.additionalData}${name}`);
    const named = (name: SealedName): SealedName => {
      if (!SealedNameSchema.safeParse(name).success)
        throw new SecretStoreError('unreadable', `${label}: that is not a sealed name`);
      return name;
    };

    const read = async (): Promise<SealedDocument> => {
      const result = await own.read(document.state);
      if (!result.ok) throw new SecretStoreError('unreadable', `${label} could not be read`);
      const bytes = result.value as unknown;
      if (bytes === undefined) return { format: 1, cipher: SECRET_CIPHER_ALGORITHM, entries: {} };
      if (!(bytes instanceof Uint8Array)) throw new SecretStoreError('unreadable', `${label} is not a file`);
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new SecretStoreError('unreadable', `${label} is not JSON`);
      }
      // Nothing from the file body reaches the message (today's `parseVaultDocument` rule).
      const parsed = SealedDocumentSchema.safeParse(decoded);
      if (!parsed.success)
        throw new SecretStoreError(
          'unreadable',
          `${label} is not a sealed document of format 1 and ${SECRET_CIPHER_ALGORITHM}`,
        );
      return parsed.data;
    };

    const write = async (next: SealedDocument): Promise<void> => {
      await own.write(document.state as never, `${JSON.stringify(next, undefined, 2)}\n` as never);
    };

    const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
      let byDocument = this.#turns.get(own);
      if (byDocument === undefined) {
        byDocument = new Map();
        this.#turns.set(own, byDocument);
      }
      const before = byDocument.get(document.state.name) ?? Promise.resolve();
      const run = before.then(work, work);
      byDocument.set(
        document.state.name,
        run.catch(() => undefined),
      );
      return await run;
    };

    const importKey = async (material: CryptoBytes): Promise<CryptoKey> =>
      await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    const opened = async (name: SealedName): Promise<Uint8Array | undefined> => {
      const sealed = (await read()).entries[named(name)];
      if (sealed === undefined) return undefined;
      const material = await this.keys.read();
      // Ciphertext with no key must never read as "nothing sealed" (today's `key_missing`).
      if (material === undefined)
        throw new SecretStoreError('key_missing', `the vault key is gone, so ${label} entry ${name} cannot be opened`);
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: decode(sealed.iv), additionalData: aad(name) },
          await importKey(material),
          decode(sealed.ciphertext),
        );
        return new Uint8Array(plain);
      } catch {
        // A GCM failure is authentication: the key is wrong or the entry was edited or moved. No cause is chained.
        throw new SecretStoreError('undecipherable', `${label} entry ${name} did not authenticate under this key`);
      }
    };

    return {
      put: async (name, value) => {
        named(name);
        await inTurn(async () => {
          const current = await read();
          const iv = owned(this.randomIv());
          const sealed = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: aad(name) },
            await importKey(await this.keys.ensure()),
            typeof value === 'string' ? utf8(value) : owned(value),
          );
          const entry: SealedEntry = { iv: encode(iv), ciphertext: encode(new Uint8Array(sealed)) };
          if (document.stamped) {
            const at = this.clock.now() as string;
            Object.assign(entry, { createdAt: current.entries[name]?.createdAt ?? at, updatedAt: at });
          }
          await write({ ...current, entries: { ...current.entries, [name]: entry } });
        });
      },
      get: async name => {
        const bytes = await opened(name);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      },
      getBytes: async name => await opened(name),
      delete: async name => {
        named(name);
        return await inTurn(async () => {
          const current = await read();
          if (current.entries[name] === undefined) return false;
          const { [name]: _forgotten, ...entries } = current.entries;
          await write({ ...current, entries });
          return true;
        });
      },
    };
  }
}
