import { ApiError, type StateFileDef, type StatePort } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import type { SealedDocumentHandle } from '@ferretry/core-vault/contract';
import type { LinkKeyVault } from '../lib/catalog-links/ports.ts';
import { CatalogLinkRefusal } from '../lib/catalog-links/refusal.ts';

/** The kernel enforces the declared format and atomic write; the domain still checks its own shape. */
export function documentStore<T>(state: StatePort, file: StateFileDef, schema: z.ZodType<T>, empty: T) {
  return {
    async read(): Promise<T> {
      const result = await state.read<unknown>(file);
      if (!result.ok) throw new ApiError(503, `${file.path} cannot be read. Nothing was changed.`, 'store_damaged');
      if (result.value === undefined) return empty;
      const checked = schema.safeParse(result.value);
      if (!checked.success)
        throw new ApiError(
          503,
          `${file.path} does not describe its declared state. Nothing was changed.`,
          'store_damaged',
        );
      return checked.data;
    },
    async write(value: T): Promise<void> {
      await state.write(file, schema.parse(value));
    },
  };
}

export function blobStore(state: StatePort, file: StateFileDef) {
  const name = (digest: string) => {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest))
      throw new ApiError(500, 'The catalog digest is invalid.', 'store_damaged');
    return digest.slice(7);
  };
  return {
    async get(digest: string): Promise<string | undefined> {
      const read = await state.read<Uint8Array>(file as StateFileDef<string, Uint8Array>, name(digest));
      if (!read.ok) throw new ApiError(503, 'The frozen catalog item cannot be read.', 'store_damaged');
      return read.value === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(read.value);
    },
    async put(digest: string, text: string): Promise<void> {
      await state.write(file, text, name(digest));
    },
  };
}

/** The vault owns sealing, 0600 and AAD. A failure never prints the key or returns an empty replacement. */
export function linkKeyVault(sealed: SealedDocumentHandle): LinkKeyVault {
  const damaged = (linkId: string) =>
    new CatalogLinkRefusal(
      'links_store_damaged',
      `The stored key of link ${linkId} did not authenticate under this vault key.`,
    );
  return {
    async put(linkId, key) {
      try {
        await sealed.put(linkId, key);
      } catch {
        throw damaged(linkId);
      }
    },
    async open(linkId) {
      try {
        return await sealed.get(linkId);
      } catch {
        throw damaged(linkId);
      }
    },
    async forget(linkId) {
      try {
        await sealed.delete(linkId);
      } catch {
        throw damaged(linkId);
      }
    },
  };
}
