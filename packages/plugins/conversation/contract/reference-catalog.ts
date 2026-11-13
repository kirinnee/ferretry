import { type CallStanding, type CapabilityDemand, defineHook } from '@ferretry/kernel/contract';
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

/** A directory of files is listed fuller than the other menus: the composer ranks the leaf itself, so the bound is today's. */
export const REFERENCE_CATALOG_FILE_MAX_ENTRIES = 2_000;

/** The most entries a provider of `prefix` is served with. */
export const referenceCatalogLimit = (prefix: ReferenceCatalogPrefix): number =>
  prefix === '@' ? REFERENCE_CATALOG_FILE_MAX_ENTRIES : REFERENCE_CATALOG_MAX_ENTRIES;

/** The longest menu query the route accepts (today's file-reference query bound); a longer one is a 400. */
export const REFERENCE_CATALOG_MAX_QUERY = 4_096;

/**
 * One entry a menu can offer. `token` is what the composer inserts after the prefix (`F12` for `&F12`, a skill name,
 * a terminal key, a ferret-root-relative path); `label` and `detail` are what the row prints. `aliases` are other
 * words the entry is found by.
 *
 * The conventions every provider follows, because the composer's menus read them:
 *   - `closed` means known but not on offer: done or dropped work, a finished ferret, a closed terminal, a file that is
 *     listed but not served (its `detail` says why). A proof still treats it as known.
 *   - `@` (files) is asked one directory at a time: the query `q` is the directory, and a folder's token ends in `/`.
 *     THE DIRECTORY IS CONFINED TO THE FERRET'S ROOT: the route refuses a `q` with a `..` segment, an absolute path
 *     or a NUL before any provider sees it, and a provider still resolves `q` under the ferret's root and answers
 *     nothing outside it (the route's refusal is the first fence, not the only one).
 *   - A provider that reads something the operator governs (files, terminals, pages, cards) DECLARES that demand. The
 *     route asks it of the caller before `entries` runs, and refuses exactly as the direct route for the same thing would.
 *   - `/` and `$` (skills) answer the skill's name; the composer writes the harness's own invocation from it.
 */
export const ReferenceCatalogEntrySchema = z.strictObject({
  token: z.string().min(1).max(512),
  label: z.string().max(256),
  detail: z.string().max(512).optional(),
  aliases: z.array(z.string().max(64)).max(4).optional(),
  closed: z.boolean().optional(),
  /**
   * The ask behind this entry was not the owner's (another ferret's, the Warden's, an automatic card): the `&` menu
   * hides it unless the reader turns "Include agent cards" on, or types its id exactly. Absent means the owner's own.
   * Only the cards' provider (Board) sets it.
   */
  agentAsked: z.boolean().optional(),
});
export type ReferenceCatalogEntry = z.infer<typeof ReferenceCatalogEntrySchema>;

/** `GET /v1/ferrets/:ferretId/references?prefix=…&q=…` (a query, because a path segment cannot carry `/`): the entries the owner of `prefix` offers for one ferret. */
export const ReferenceCatalogAnswerSchema = z.strictObject({
  ferret: FerretIdSchema,
  prefix: ReferenceCatalogPrefixSchema,
  /** False when no installed plugin provides the prefix (or its provider is off): `entries` is then empty. */
  provided: z.boolean(),
  entries: z.array(ReferenceCatalogEntrySchema).max(REFERENCE_CATALOG_FILE_MAX_ENTRIES),
});
export type ReferenceCatalogAnswer = z.infer<typeof ReferenceCatalogAnswerSchema>;

/** Who is asking, as Gate stood them: what a provider needs to apply its own checks. Never a token or a digest. */
export type ReferenceCatalogCaller = Pick<CallStanding, 'actor' | 'credential' | 'governance' | 'presentation'>;

/** What a provider is asked: one ferret, the menu's query, and the caller. */
export interface ReferenceCatalogInput {
  readonly ferret: string;
  readonly query?: string;
  readonly caller: ReferenceCatalogCaller;
}

/**
 * What a provider supplies: the entries of its prefix for one ferret, as raw text (Conversation masks the answer).
 *
 * `demand` is the operator's question the SAME facts already ask on their own routes: whatever the provider's own
 * direct read route declares (`filesystem` use for `@`, `terminal` use for `%terminal`, `browser` use for `%browser`,
 * `fleet` use for `&`, because the board's own reads ask it). It is decided before `entries` runs; a provider whose
 * facts are not governed declares none.
 */
export interface ReferenceCatalogProvider {
  readonly demand?: CapabilityDemand;
  entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]>;
}

/** Board, Agenda, Skills, Terminals, Browsers and Ferrets take this with their prefix as the key. */
export const ReferenceCatalog = defineHook('reference.catalog', {
  mode: 'provide',
  key: ReferenceCatalogPrefixSchema,
  value: z.custom<ReferenceCatalogProvider>(),
});
