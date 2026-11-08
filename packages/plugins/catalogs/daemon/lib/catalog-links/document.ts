/**
 * `state/catalogs/links.json`: every download link this machine made, and the facts it needs to turn one off,
 * count one, or finish one a crash cut short (docs/catalogs.md § Links).
 *
 * It holds NO URL, NO KEY and no fetch token. A public link's key is in `link-keys.json`, sealed; a one-time link's
 * key is held by nobody. `bundleId` IS here, because the store names a link by it and an owner cannot turn a link off
 * without it. It is an address, not a secret: it opens nothing without the key.
 */
import {
  CatalogItemNameSchema,
  CatalogLinkIdSchema,
  CatalogLinkKindSchema,
  CatalogLinkStateSchema,
  CATALOG_LINKS_MAX_LIVE,
  DaemonIdSchema,
  InstantSchema,
  LinkBundleIdSchema,
  SharedCatalogItemIdSchema,
} from '../boundary.ts';
import { z } from 'zod';
import { linkStoreSiteProblem } from './store-origin.ts';

const LINKS_SCHEMA_VERSION = 1;
/** Links that are not live and are still remembered, so the list can say what happened to them. */
export const LINKS_ENDED_KEPT_MAX = 500;
/** The most the file holds: every live link and every remembered one. */
const LINKS_DOCUMENT_MAX = CATALOG_LINKS_MAX_LIVE + LINKS_ENDED_KEPT_MAX;
/** How long an ended, used or expired link is remembered. */
export const LINK_FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const InstallCap = z.number().int().min(1).max(10_000);
const Sequence = z.number().int().min(1).max(0xffffffff);

/** A change to a public link that was begun and not yet confirmed: committed or dropped by what the store reports. */
const PendingUploadSchema = z.strictObject({
  sequence: Sequence,
  version: z.number().int().min(1),
  notAfter: InstantSchema,
  expiresAt: InstantSchema.optional(),
  installCap: InstallCap.optional(),
  /** When the upload's document was signed: the link's `issuedAt` once it is committed. */
  issuedAt: InstantSchema.optional(),
  /** The store had lapsed the link and this upload puts it back. */
  revived: z.boolean().optional(),
});
export type PendingUpload = z.infer<typeof PendingUploadSchema>;

/** `identity-changed`: this machine's identity changed, so the store no longer takes this link's owner (docs/catalogs.md § Links). */
const LINK_END_REASONS = ['owner', 'expired', 'used', 'item-gone', 'identity-changed'] as const;

const StoredLinkSchema = z.strictObject({
  linkId: CatalogLinkIdSchema,
  itemId: SharedCatalogItemIdSchema,
  name: CatalogItemNameSchema,
  itemKind: z.enum(['skill', 'mcp']),
  version: z.number().int().min(1),
  kind: CatalogLinkKindSchema,
  state: CatalogLinkStateSchema,
  createdAt: InstantSchema,
  expiresAt: InstantSchema.optional(),
  installCap: InstallCap.optional(),
  opens: z.number().int().min(0),
  opensCheckedAt: InstantSchema.optional(),
  bundleId: LinkBundleIdSchema,
  /**
   * The daemon id that signed the upload. The store answers `link_unknown` to a delete from anyone but the uploader,
   * so that answer means "already gone" only while this is still the current identity.
   */
  publisher: DaemonIdSchema,
  /** The store this link was uploaded to: later operations go here, never to a store discovered afterwards. */
  storeOrigin: z.string().refine(value => linkStoreSiteProblem(value) === null, { message: 'not an https origin' }),
  /** Whether the URL names the store (`s=`): true only for a self-hosted one. */
  emitsStoreOrigin: z.boolean(),
  sequence: Sequence,
  issuedAt: InstantSchema,
  notAfter: InstantSchema,
  servedSince: InstantSchema,
  /** The vault entry holding the key: the link id, present for a public link and never for a one-time link. */
  keyRef: CatalogLinkIdSchema.optional(),
  pendingUpload: PendingUploadSchema.optional(),
  /** The version this link served before its latest move. */
  movedFrom: z.number().int().min(1).optional(),
  /** When the store had lapsed this link and it was put back. */
  revivedAt: InstantSchema.optional(),
  endedAt: InstantSchema.optional(),
  endReason: z.enum(LINK_END_REASONS).optional(),
});
export type StoredLink = z.infer<typeof StoredLinkSchema>;

const isHeld = (link: StoredLink): boolean =>
  link.state === 'pending' || link.state === 'live' || link.state === 'ending';

/** Links the store still serves or may still serve: they count against the cap of 50. */
export const heldCount = (links: readonly StoredLink[]): number => links.filter(isHeld).length;

function firstProblem(links: readonly StoredLink[]): string | undefined {
  const ids = new Set<string>();
  const bundles = new Set<string>();
  for (const link of links) {
    if (ids.has(link.linkId)) return `${link.linkId} is listed twice`;
    ids.add(link.linkId);
    if (bundles.has(link.bundleId)) return 'two links share one bundle id';
    bundles.add(link.bundleId);
    if (link.kind === 'one-time') {
      if (link.keyRef !== undefined) return `${link.linkId} is one-time and keeps a key`;
      if (link.sequence !== 1) return `${link.linkId} is one-time and was uploaded again`;
      if (link.expiresAt === undefined) return `${link.linkId} is one-time and has no end`;
    } else if (link.keyRef === undefined && isHeld(link)) return `${link.linkId} is public and has no key`;
    if (link.keyRef !== undefined && link.keyRef !== link.linkId) return `${link.linkId} names another link's key`;
  }
  return heldCount(links) > CATALOG_LINKS_MAX_LIVE ? 'more links are live than one machine may keep' : undefined;
}

export const LinksDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(LINKS_SCHEMA_VERSION),
    links: z.array(StoredLinkSchema).max(LINKS_DOCUMENT_MAX),
  })
  .check(ctx => {
    const problem = firstProblem(ctx.value.links);
    if (problem !== undefined) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value, path: ['links'] });
  });
export type LinksDocument = z.infer<typeof LinksDocumentSchema>;

export const EMPTY_LINKS_DOCUMENT: LinksDocument = { schemaVersion: LINKS_SCHEMA_VERSION, links: [] };

export const findLink = (document: LinksDocument, linkId: string): StoredLink | undefined =>
  document.links.find(link => link.linkId === linkId);

/** The document with this link added, or replacing the one of the same id. */
export const withLink = (document: LinksDocument, link: StoredLink): LinksDocument => ({
  ...document,
  links: document.links.some(candidate => candidate.linkId === link.linkId)
    ? document.links.map(candidate => (candidate.linkId === link.linkId ? link : candidate))
    : [...document.links, link],
});

export const withoutLink = (document: LinksDocument, linkId: string): LinksDocument => ({
  ...document,
  links: document.links.filter(link => link.linkId !== linkId),
});

/**
 * What is forgotten: a link that ended more than 30 days ago, then the oldest ended ones past 500. A link that is
 * pending, live or ending is never forgotten.
 */
export function pruned(document: LinksDocument, now: number): LinksDocument {
  const stale = (link: StoredLink): boolean =>
    !isHeld(link) && link.endedAt !== undefined && now - Date.parse(link.endedAt) > LINK_FORGET_AFTER_MS;
  const kept = document.links.filter(link => !stale(link));
  const ended = kept.filter(link => !isHeld(link));
  const drop = new Set(
    ended
      .toSorted((a, b) => (a.endedAt ?? a.createdAt).localeCompare(b.endedAt ?? b.createdAt))
      .slice(0, Math.max(0, ended.length - LINKS_ENDED_KEPT_MAX))
      .map(link => link.linkId),
  );
  return { ...document, links: kept.filter(link => !drop.has(link.linkId)) };
}
