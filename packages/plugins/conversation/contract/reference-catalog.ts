import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

/**
 * THE COMPOSER'S REFERENCE CATALOG (lead decision Q6): what the `:`, `@`, `&`, `!`, `/`, `$`, `%terminal` and `%browser`
 * menus of a ferret's composer offer. Conversation owns the composer but not the facts — a ferret's cards are Board's,
 * its asks Agenda's, its skills Skills', its terminals and pages Terminals' and Browsers', its files and the other
 * ferrets Ferrets' — so each owner PROVIDES the entries of its own prefix through this hook, keyed by the prefix exactly
 * as the reference grammar (docs/reference-standard.md) and the renderer keys (`reference:<prefix>`) spell it.
 *
 * A prefix nobody provides answers no entries, never an error: the menu for it is simply empty.
 */
export const REFERENCE_CATALOG_PREFIXES = [':', '@', '&', '!', '/', '$', '%terminal', '%browser'] as const;
export const ReferenceCatalogPrefixSchema = z.enum(REFERENCE_CATALOG_PREFIXES);
export type ReferenceCatalogPrefix = z.infer<typeof ReferenceCatalogPrefixSchema>;

/** The most entries one prefix answers with; a menu shows the first few. */
export const REFERENCE_CATALOG_MAX_ENTRIES = 200;

/**
 * One entry a menu can offer. `token` is what the composer inserts after the prefix (`F12` for `&F12`, a skill name,
 * a terminal key, a ferret-root-relative path); `label` and `detail` are what the row prints. `aliases` are other
 * words the entry is found by.
 *
 * The conventions every provider follows, because the composer's menus read them:
 *   - `closed` means known but not on offer: done or dropped work, a finished ferret, a closed terminal, a file that is
 *     listed but not served (its `detail` says why). A proof still treats it as known.
 *   - `@` (files) is asked one directory at a time: the query `q` is the directory, and a folder's token ends in `/`.
 *   - `/` and `$` (skills) answer the skill's name; the composer writes the harness's own invocation from it.
 */
export const ReferenceCatalogEntrySchema = z.strictObject({
  token: z.string().min(1).max(512),
  label: z.string().max(512),
  detail: z.string().max(1_024).optional(),
  aliases: z.array(z.string().max(512)).max(16).optional(),
  closed: z.boolean().optional(),
});
export type ReferenceCatalogEntry = z.infer<typeof ReferenceCatalogEntrySchema>;

/** `GET /v1/ferrets/:ferretId/references?prefix=…&q=…` (a query, because a path segment cannot carry `/`): the entries the owner of `prefix` offers for one ferret. */
export const ReferenceCatalogAnswerSchema = z.strictObject({
  ferret: FerretIdSchema,
  prefix: ReferenceCatalogPrefixSchema,
  /** False when no installed plugin provides the prefix (or its provider is off): `entries` is then empty. */
  provided: z.boolean(),
  entries: z.array(ReferenceCatalogEntrySchema).max(REFERENCE_CATALOG_MAX_ENTRIES),
});
export type ReferenceCatalogAnswer = z.infer<typeof ReferenceCatalogAnswerSchema>;

/** What a provider supplies: the entries of its prefix for one ferret, as raw text (Conversation masks the answer). */
export interface ReferenceCatalogProvider {
  entries(input: { readonly ferret: string; readonly query?: string }): Promise<readonly ReferenceCatalogEntry[]>;
}

/** Board, Agenda, Skills, Terminals, Browsers and Ferrets take this with their prefix as the key. */
export const ReferenceCatalog = defineHook('reference.catalog', {
  mode: 'provide',
  key: ReferenceCatalogPrefixSchema,
  value: z.custom<ReferenceCatalogProvider>(),
});
