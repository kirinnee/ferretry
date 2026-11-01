/**
 * Freezing: a source read, made into one catalog item version and fingerprinted. Pure over a hash.
 *
 * ## Two digests
 *
 * - `digest` is the item's digest as ONE catalog's signed manifest lists it. It covers the item's identity
 *   (its catalog, its id and its version number), because that is what a reader verifies.
 * - `contentDigest` is the same item with that identity normalised (`sharedCopy`), so the SAME content
 *   hashes the same whichever catalog, item or version it becomes. A preview answers it, an add sends it
 *   back, "this is the same as version 2" compares it, and the one frozen copy on disk is stored by it.
 *   Because the summary is part of the item, it is part of what is bound.
 *
 * A catalog's item is the shared copy with its three identity fields put back (`itemForCatalog`), and its
 * digest is checked against the one the document lists for that catalog every time it is read.
 */
import {
  CATALOG_SKILL_ENTRY_FILE,
  type CatalogDigest,
  type CatalogHarness,
  type CatalogInstallWarning,
  type CatalogMcpSetup,
  type CatalogReviewEntry,
  type CatalogSkill,
  CatalogSkillSchema,
  CatalogSummarySchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  catalogItemReview,
  catalogItemWarnings,
  revealHidden,
  SHARED_CATALOG_ITEM_FORMAT,
  catalogCanonicalText,
  catalogDigestOf,
} from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';
import { skillFrontMatter } from '../skills/front-matter.ts';
import { CatalogRefusal } from './refusal.ts';

/** An id no catalog has: a version's shared copy is written under it so the catalog does not matter. */
export const NORMALISED_CATALOG_ID = `cat_${'A'.repeat(22)}`;

/** An id no item has: a version's content is hashed under it so the identity does not matter. */
export const NORMALISED_ITEM_ID = `itm_${'A'.repeat(22)}`;

export type FrozenBody =
  | { readonly kind: 'skill'; readonly skill: CatalogSkill }
  | { readonly kind: 'mcp'; readonly mcp: CatalogMcpSetup };

export interface FreezeInput {
  readonly publisher: string;
  readonly catalogId: string;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly name: string;
  readonly summary: string;
  readonly harness?: CatalogHarness | undefined;
  readonly body: FrozenBody;
}

/** The item the input makes, parsed through the contract, or the contract's sentence for why it is refused. */
export function freezeItem(input: FreezeInput): SharedCatalogItem {
  const head = {
    format: SHARED_CATALOG_ITEM_FORMAT,
    version: 1,
    publisher: input.publisher,
    catalogId: input.catalogId,
    itemId: input.itemId,
    itemVersion: input.itemVersion,
    name: input.name,
    summary: input.summary,
    ...(input.harness === undefined ? {} : { harness: input.harness }),
  };
  const result = SharedCatalogItemSchema.safeParse({
    ...head,
    kind: input.body.kind,
    [input.body.kind]: bodyOf(input.body),
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '' : ` (at ${issue.path.join('.')})`;
    throw new CatalogRefusal(
      'source_refused',
      `${input.name} cannot be shared: ${issue?.message ?? 'it is malformed'}${where}.`,
    );
  }
  return result.data;
}

const bodyOf = (body: FrozenBody): unknown => (body.kind === 'skill' ? body.skill : body.mcp);

/**
 * The catalog-independent copy of an item: its catalog, id and version number replaced by the fixed
 * placeholders. This is what is kept on disk, once per version, and what `contentDigest` is the digest of.
 */
export const sharedCopy = (item: SharedCatalogItem): SharedCatalogItem => ({
  ...item,
  catalogId: NORMALISED_CATALOG_ID,
  itemId: NORMALISED_ITEM_ID,
  itemVersion: 1,
});

export interface CatalogIdentity {
  readonly catalogId: string;
  readonly itemId: string;
  readonly itemVersion: number;
}

/** A shared copy made into the item one catalog's manifest lists: the three head fields, nothing else. */
export const itemForCatalog = (shared: SharedCatalogItem, identity: CatalogIdentity): SharedCatalogItem => ({
  ...shared,
  catalogId: identity.catalogId,
  itemId: identity.itemId,
  itemVersion: identity.itemVersion,
});

export interface Fingerprint {
  /** The item as given, as its catalog's manifest would list it. */
  readonly digest: CatalogDigest;
  /** The shared copy: the same content whichever catalog, item or version it becomes. */
  readonly contentDigest: CatalogDigest;
  /** Bytes of the item as given. */
  readonly size: number;
}

/** Both digests of an item. A document with no canonical spelling is refused rather than guessed at. */
export async function fingerprint(crypto: RelayCrypto, item: SharedCatalogItem): Promise<Fingerprint> {
  const real = await canonicalOrRefuse(crypto, item);
  const shared = await canonicalOrRefuse(crypto, sharedCopy(item));
  return { digest: real.digest, contentDigest: shared.digest, size: real.size };
}

export interface CanonicalCopy {
  readonly digest: CatalogDigest;
  readonly size: number;
  /** The canonical text: what is written to disk and what the digest covers. */
  readonly text: string;
}

/** An item's canonical text with its digest and size, or `undefined` when it has no one spelling. */
export async function canonicalCopy(crypto: RelayCrypto, item: SharedCatalogItem): Promise<CanonicalCopy | undefined> {
  const canonical = catalogCanonicalText(item);
  if (!canonical.ok) return undefined;
  const bytes = new TextEncoder().encode(canonical.text);
  return { digest: catalogDigestOf(await crypto.sha256(bytes)), size: bytes.length, text: canonical.text };
}

/** `canonicalCopy`, or the refusal that this item has no one canonical spelling and so cannot be shared. */
export async function canonicalOrRefuse(crypto: RelayCrypto, item: SharedCatalogItem): Promise<CanonicalCopy> {
  const copy = await canonicalCopy(crypto, item);
  if (copy === undefined)
    throw new CatalogRefusal('source_refused', `${item.name} has no one canonical spelling, so it cannot be shared.`);
  return copy;
}

/** How many files a skill holds, for "4 files": an MCP setup holds none. */
export const fileCountOf = (item: SharedCatalogItem): number | undefined =>
  item.kind === 'skill' ? item.skill.files.length : undefined;

export interface ItemReading {
  readonly review: readonly CatalogReviewEntry[];
  readonly warnings: readonly CatalogInstallWarning[];
}

/** What an installer would be shown of this item: the same functions the installer's own preview calls. */
export const readItem = (item: SharedCatalogItem): ItemReading => ({
  review: catalogItemReview(item),
  warnings: catalogItemWarnings(item),
});

// ── Summaries ────────────────────────────────────────────────────────────────────────────────────

const ELLIPSIS = String.fromCodePoint(0x2026);

/** A description made into the one line an item shows: whitespace folded, trimmed, cut to the bound. */
export function summaryFromDescription(description: string): string | undefined {
  const line = description.replace(/\s+/gu, ' ').trim();
  const bound = 280;
  const characters = Array.from(line);
  const cut =
    characters.length <= bound
      ? line
      : `${characters
          .slice(0, bound - 1)
          .join('')
          .trimEnd()}${ELLIPSIS}`;
  return CatalogSummarySchema.safeParse(cut).success ? cut : undefined;
}

/** What a SKILL.md says about itself in its front matter, as a summary, or why that is not usable. */
export function skillSummary(skill: CatalogSkill): { readonly summary: string } | { readonly problem: string } {
  const manifest = skill.files.find(file => file.path === CATALOG_SKILL_ENTRY_FILE);
  const parsed = manifest === undefined ? undefined : skillFrontMatter(manifest.content);
  if (parsed === undefined)
    return {
      problem: `${CATALOG_SKILL_ENTRY_FILE} has no description in its front matter, so there is nothing to show beside it. Give a summary of your own.`,
    };
  const summary = summaryFromDescription(parsed.description);
  if (summary === undefined)
    return {
      problem: `The description in ${CATALOG_SKILL_ENTRY_FILE} holds characters that cannot be seen (${revealHidden(parsed.description).slice(0, 80)}). Give a summary of your own.`,
    };
  return { summary };
}

/** Whether a skill's files, as read, make a skill the contract accepts. */
export function skillOf(files: readonly { readonly path: string; readonly content: string }[]): CatalogSkill | string {
  const result = CatalogSkillSchema.safeParse({ files });
  if (result.success) return result.data;
  return result.error.issues[0]?.message ?? 'it is malformed';
}

/** A default one line for an MCP setup, when the person gave none. */
export const defaultMcpSummary = (name: string): string => `MCP server ${name}`;
