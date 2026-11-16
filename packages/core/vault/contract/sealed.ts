import { definePort, defineState, type StateFileDef, type StatePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { SECRET_CIPHER_ALGORITHM } from './store.ts';

/**
 * Sealed documents (lead-approved contract change C): a plugin's OWN sealed values, kept by name, for what its daemon
 * half must hold and open itself — MCP refresh tokens and client secrets, account passwords and 2FA seeds, catalog
 * link keys. Today each is a separate sealed document under the vault's key (`mcp-oauth-secrets.json`,
 * `login-secrets.json`, `catalogs/link-keys.json`); here each is a `store: 'secret'` file in its owner's own
 * `state/<plugin>/` folder.
 *
 * NOT THE SECRET STORE. Nothing here is a secret in the `${secret:NAME}` sense: no route lists, returns or writes one,
 * `use` cannot spend one, `${secret:…}` cannot resolve one, and it is never handed to an app or CLI half (the port is
 * reachable only from a daemon half's `build(ctx)`). Ferrets still only ever use secrets by name.
 *
 * SCOPE IS THE CALLER'S OWN STATE FOLDER. A handle is opened over the `StatePort` the kernel gave the calling plugin,
 * which is rooted at `state/<that plugin>/` and refuses any file the plugin did not declare. A plugin names a
 * document, never another plugin: plugin A cannot read, list or delete plugin B's documents, because it holds no port
 * onto B's folder and its own port refuses B's declaration.
 *
 * BYTES ARE TODAY'S (spine D16): AES-256-GCM under the vault's own key (`state/vault/vault.key`, which the caller never
 * sees), a random 96-bit IV per seal, `iv` and `ciphertext` base64, `additionalData + name` as the AAD. The envelope
 * is `{ "format": 1, "cipher", "entries" }` where today's was `{ "v": 1, … }`; every entry moves byte for byte and
 * nothing is decrypted and re-encrypted to move it.
 */

/** A name inside one document: today's secret names (`MCP_…_REFRESH`) and link ids (`lnk_…`) both fit. */
export const SealedNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u, 'a sealed name is letters, digits, `_`, `.`, `:` or `-`');
export type SealedName = z.infer<typeof SealedNameSchema>;

/** One sealed entry. `createdAt`/`updatedAt` are written only by a stamped document (today's vault-shaped ones). */
export const SealedEntrySchema = z.strictObject({
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
});
export type SealedEntry = z.infer<typeof SealedEntrySchema>;

export const SealedDocumentSchema = z.strictObject({
  format: z.literal(1),
  cipher: z.literal(SECRET_CIPHER_ALGORITHM),
  entries: z.record(SealedNameSchema, SealedEntrySchema),
});
export type SealedDocument = z.infer<typeof SealedDocumentSchema>;

/**
 * One sealed document a plugin declares. List `state` in the manifest's `data.state` too: the kernel refuses a file
 * its plugin did not declare, and that refusal is what keeps one plugin out of another's documents.
 */
export interface SealedDocumentDef {
  readonly kind: 'sealed-document';
  /** The plugin's own `store: 'secret'` file, `0600`. */
  readonly state: StateFileDef;
  /**
   * Today's AAD prefix: `''` for the vault-shaped documents (the name alone is the AAD), `'catalog-link:'` for the
   * link keys.
   */
  readonly additionalData: string;
  /** Whether entries carry `createdAt`/`updatedAt` (today's vault-shaped documents do; the link keys do not). */
  readonly stamped: boolean;
}

export function defineSealedDocument<const Name extends string>(spec: {
  readonly name: Name;
  readonly path: string;
  readonly additionalData?: string;
  readonly stamped?: boolean;
}): SealedDocumentDef {
  return Object.freeze({
    kind: 'sealed-document',
    state: defineState({ name: spec.name, path: spec.path, store: 'secret', format: 1, mode: 0o600 }),
    additionalData: spec.additionalData ?? '',
    stamped: spec.stamped ?? true,
  });
}

/** One plugin's handle on one of its own sealed documents. A failure never carries a value in its message. */
export interface SealedDocumentHandle {
  /** Lists only the names stored in this document, never their values. */
  names(): Promise<readonly SealedName[]>;
  /** Seals `value` (text as UTF-8, or raw bytes) under `name`, replacing what was there. */
  put(name: SealedName, value: string | Uint8Array): Promise<void>;
  /** The value as UTF-8 text, or `undefined` when nothing is sealed under `name`. */
  get(name: SealedName): Promise<string | undefined>;
  /** The value as the bytes that were sealed, or `undefined`. */
  getBytes(name: SealedName): Promise<Uint8Array | undefined>;
  /** Forgets `name`. Answers whether there was one. */
  delete(name: SealedName): Promise<boolean>;
}

/**
 * The sealed-document port (daemon only). `own` is the calling plugin's `ctx.kernel.state`; there is no way to name
 * another plugin.
 */
export interface SealedDocumentsApi {
  open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle;
}

export const SealedDocumentsPort = definePort<SealedDocumentsApi>('vault.sealed-documents');
