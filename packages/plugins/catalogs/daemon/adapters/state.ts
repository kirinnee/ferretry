import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import type { SealedDocumentHandle } from '@ferretry/core-vault/contract';
import type { LinkKeyVault } from '../lib/catalog-links/ports.ts';
import { CatalogLinkRefusal } from '../lib/catalog-links/refusal.ts';
import { documentProblem } from '../lib/catalog-members/document.ts';
import { CatalogInstallStateError } from '../lib/catalog-installs/store.ts';
import { CatalogMemberRefusal } from '../lib/catalog-members/refusal.ts';
import { CatalogRefusal } from '../lib/shared-catalogs/refusal.ts';

/**
 * What a stored document says when it cannot be used: each store keeps the refusal class, code, status and words
 * today's store spoke, because a caller catches that class and a person reads that sentence. A damaged file is never
 * read as an empty one.
 */
export interface DocumentDamage {
  /** The file is there but cannot be read (it is not the declared format, or the bytes are unreadable). */
  unreadable(file: string): Error;
  /** The file reads, but is not the document this daemon writes. `problem` is the first thing wrong, in words. */
  invalid(file: string, problem: string | null): Error;
  /** A document that breaks a rule of its file is refused before anything is written. */
  unwritable(file: string, problem: string | null): Error;
}

const unreadableWhy = 'it is not JSON';
const malformed = (problem: string | null): string => problem ?? 'it is malformed';

/** `links.json`: a `links_store_damaged` link refusal (500), with today's remedy. */
export const linksDamage: DocumentDamage = {
  unreadable: file =>
    new CatalogLinkRefusal(
      'links_store_damaged',
      `${file} cannot be read: ${unreadableWhy}. Nothing was changed. Restore the file from a backup, or move it aside to start with no links.`,
    ),
  invalid: (file, problem) =>
    new CatalogLinkRefusal(
      'links_store_damaged',
      `${file} cannot be read: ${malformed(problem)}. Nothing was changed. Restore the file from a backup, or move it aside to start with no links.`,
    ),
  unwritable: (file, problem) =>
    new CatalogLinkRefusal(
      'links_store_damaged',
      `${file} was not written: ${malformed(problem)}. Nothing was changed.`,
    ),
};

/** `members.json` and `shares.json`: a `store_damaged` member refusal (500). */
export const membersDamage: DocumentDamage = {
  unreadable: file =>
    new CatalogMemberRefusal(
      'store_damaged',
      `${file} cannot be read: ${unreadableWhy}. Nothing was changed. Restore the file from a backup, or move it aside to start with nobody shared with.`,
    ),
  invalid: (file, problem) =>
    new CatalogMemberRefusal(
      'store_damaged',
      `${file} cannot be read: ${malformed(problem)}. Nothing was changed. Restore the file from a backup, or move it aside to start with nobody shared with.`,
    ),
  unwritable: (file, problem) =>
    new CatalogMemberRefusal('store_damaged', `${file} was not written: ${malformed(problem)}. Nothing was changed.`),
};

/** `catalogs.json`: a `store_damaged` catalog refusal (500). */
export const catalogsDamage: DocumentDamage = {
  unreadable: file =>
    new CatalogRefusal(
      'store_damaged',
      `${file} cannot be read: ${unreadableWhy}. Nothing was changed. Restore the file from a backup, or move it aside to start with no catalogs.`,
    ),
  invalid: (file, problem) =>
    new CatalogRefusal(
      'store_damaged',
      `${file} cannot be read: ${malformed(problem)}. Nothing was changed. Restore the file from a backup, or move it aside to start with no catalogs.`,
    ),
  unwritable: (file, problem) =>
    new CatalogRefusal('store_damaged', `${file} was not written: ${malformed(problem)}. Nothing was changed.`),
};

/** `installs.json` and the install preferences: a `CatalogInstallStateError` (500 `catalog_installs_unreadable`). */
export const installsDamage = (what: 'install' | 'preference', records: string): DocumentDamage => ({
  unreadable: file => new CatalogInstallStateError(`${file} is not JSON, so no ${what} was changed`),
  invalid: file =>
    new CatalogInstallStateError(`${file} is not a record of ${records} this daemon writes, so no ${what} was changed`),
  unwritable: file =>
    new CatalogInstallStateError(`${file} is not a record of ${records} this daemon writes, so no ${what} was changed`),
});

/** The kernel enforces the declared format and atomic write; the domain still checks its own shape. */
export function documentStore<T>(
  state: StatePort,
  file: StateFileDef,
  schema: z.ZodType<T>,
  empty: T,
  damage: DocumentDamage,
) {
  return {
    async read(): Promise<T> {
      const result = await state.read<unknown>(file);
      if (!result.ok) throw damage.unreadable(file.path);
      if (result.value === undefined) return empty;
      const checked = schema.safeParse(result.value);
      if (!checked.success) throw damage.invalid(file.path, documentProblem(checked));
      return checked.data;
    },
    async write(value: T): Promise<void> {
      const checked = schema.safeParse(value);
      if (!checked.success) throw damage.unwritable(file.path, documentProblem(checked));
      await state.write(file, checked.data);
    },
  };
}

export function blobStore(state: StatePort, file: StateFileDef) {
  const name = (digest: string) => {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest))
      throw new CatalogRefusal('store_damaged', 'a frozen item is listed under a digest that is not a sha256.');
    return digest.slice(7);
  };
  return {
    async get(digest: string): Promise<string | undefined> {
      const read = await state.read<Uint8Array>(file as StateFileDef<string, Uint8Array>, name(digest));
      if (!read.ok)
        throw new CatalogRefusal('store_damaged', 'a frozen catalog item cannot be read. Nothing was changed.');
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
