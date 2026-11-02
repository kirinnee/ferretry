/**
 * Links: ONE catalog item, signed by its publisher and shared as a URL (docs/catalogs.md § Links). This
 * file is the signed document and the bundle a link's envelope carries; the URL grammar and the owner's
 * routes are `catalog-link.ts`, and the sealing, the signing and the store wire live in `@ferretry/relay`.
 *
 * ## What the signature binds
 *
 * A link is not a catalog: nobody joins, nothing is revised, and the publisher is not asked again. So the
 * signed document binds everything a stranger could be lied to about — WHO (publisher), WHICH link
 * (`linkId`, `bundleId`), WHAT KIND (one-time or public), HOW FRESH (`sequence`, `issuedAt`, `notAfter`) and
 * WHAT (the item line: id, kind, name, summary, version, digest, size). `installCap` is not signed: the
 * store enforces it, and changing it must not need a re-sign.
 *
 * ## The item names `LINK_ITEM_CATALOG_ID`
 *
 * A link's item is an ordinary `SharedCatalogItem`, so the review and the installer stay as they are. Its
 * `catalogId` is the placeholder every shared copy is stored under: no real catalog ever has that id, so a
 * link item and a catalog item can never be mistaken for each other.
 *
 * ## No schema here transforms
 *
 * As in `shared-catalog.ts`: a signature covers the canonical JSON of the PARSED document, so every schema
 * below only accepts or refuses.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema } from './pairing.ts';
import {
  CatalogLabelSchema,
  CatalogSignatureSchema,
  CatalogSpkiSchema,
  SharedCatalogItemSchema,
  SharedCatalogManifestEntrySchema,
} from './shared-catalog.ts';

export const CATALOG_LINK_FORMAT = 'ferretry-catalog-link' as const;
export const CATALOG_LINK_BUNDLE_FORMAT = 'ferretry-catalog-link-bundle' as const;

/**
 * The domain label a link signature covers. New, so a manifest or version-list signature never verifies as a
 * link and the reverse, and neither does any handshake, claim, offer or store request the same key signs.
 */
export const CATALOG_LINK_SIGNATURE_LABEL = 'ferretry-catalog-link-v1' as const;

/**
 * The `catalogId` a link's item (and every shared copy in the publisher's store) carries: `cat_` and 22
 * `A`s. No catalog has it; the daemon refuses it as a real catalog id.
 */
export const LINK_ITEM_CATALOG_ID = 'cat_AAAAAAAAAAAAAAAAAAAAAA' as const;

/** The longest one signed copy of a link serves, measured from the instant it was uploaded. */
export const LINK_MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest a one-time link lives. */
export const LINK_ONE_TIME_MAX_MS = 24 * 60 * 60 * 1000;

/** `lnk_` and 22 base64url characters: 128 random bits, the publisher's own name for one link. */
export const CatalogLinkIdSchema = z.string().regex(/^lnk_[A-Za-z0-9_-]{22}$/u, 'invalid link id');
export type CatalogLinkId = z.infer<typeof CatalogLinkIdSchema>;

/** 16 random bytes as base64url: where the store keeps one link's envelope. Never a counter or a name. */
export const LinkBundleIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u, 'invalid link bundle id');
export type LinkBundleId = z.infer<typeof LinkBundleIdSchema>;

/** 32 random bytes as base64url: the link's secret, which lives in the URL fragment only. */
export const LinkKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'invalid link key');
export type LinkKey = z.infer<typeof LinkKeySchema>;

export const CATALOG_LINK_KINDS = ['one-time', 'public'] as const;
export const CatalogLinkKindSchema = z.enum(CATALOG_LINK_KINDS);
export type CatalogLinkKind = z.infer<typeof CatalogLinkKindSchema>;

// ── The signed document ──────────────────────────────────────────────────────────────────────────

/**
 * What a publisher signs for one upload of one link. `sequence` goes up by one on every upload of the same
 * link (a move, a refresh, a changed end), so a reader that has seen sequence 4 refuses a signed 3 that a
 * store hands it later.
 */
export const SharedCatalogLinkSchema = z
  .strictObject({
    format: z.literal(CATALOG_LINK_FORMAT),
    version: z.literal(1),
    publisher: DaemonIdSchema,
    /** The name the publisher gives itself. A reader shows its OWN label for the publisher beside it. */
    publisherName: CatalogLabelSchema,
    linkId: CatalogLinkIdSchema,
    bundleId: LinkBundleIdSchema,
    kind: CatalogLinkKindSchema,
    sequence: z.number().int().min(1).max(0xffffffff),
    /** The instant of this upload. */
    issuedAt: InstantSchema,
    /** The hard end of this signed copy: `min(expiresAt, issuedAt + 30 days)`. */
    notAfter: InstantSchema,
    /** The end the owner chose. Absent means no end. */
    expiresAt: InstantSchema.optional(),
    /** One skill or MCP setup: id, kind, name, summary, version, digest and size of the item the bundle carries. */
    item: SharedCatalogManifestEntrySchema,
  })
  .check(ctx => {
    const link = ctx.value;
    const issue = (message: string, path: string) =>
      ctx.issues.push({ code: 'custom', message, input: link, path: [path] });
    const issued = Date.parse(link.issuedAt);
    const notAfter = Date.parse(link.notAfter);
    if (notAfter <= issued) issue('notAfter is not after issuedAt', 'notAfter');
    if (notAfter - issued > LINK_MAX_LEASE_MS) issue('notAfter is more than 30 days after issuedAt', 'notAfter');
    if (link.expiresAt !== undefined && notAfter > Date.parse(link.expiresAt))
      issue('notAfter is after expiresAt', 'notAfter');
    if (link.kind === 'one-time') {
      if (link.sequence !== 1) issue('a one-time link is uploaded once', 'sequence');
      if (link.expiresAt === undefined) issue('a one-time link has an end', 'expiresAt');
      else if (Date.parse(link.expiresAt) - issued > LINK_ONE_TIME_MAX_MS)
        issue('a one-time link ends within a day', 'expiresAt');
    }
    if (link.item.kind === 'artifact') issue('a link carries a skill or an MCP setup, not an artifact', 'item');
  });
export type SharedCatalogLink = z.infer<typeof SharedCatalogLinkSchema>;

/** A link document with the publisher's public key and its signature (`catalog-signature.ts` in `@ferretry/relay`). */
export const SignedCatalogLinkSchema = z.strictObject({
  link: SharedCatalogLinkSchema,
  /** The publisher's Ed25519 identity, SubjectPublicKeyInfo DER. Must hash to `link.publisher`. */
  spki: CatalogSpkiSchema,
  /** Ed25519 over {@link catalogLinkSignedBytes}. */
  sig: CatalogSignatureSchema,
});
export type SignedCatalogLink = z.infer<typeof SignedCatalogLinkSchema>;

// ── The bundle a link's envelope carries ─────────────────────────────────────────────────────────

/**
 * Exactly one item and the document that signs it. The shape alone does not check that `item` is the item
 * `signedLink.link.item` describes: `verifyLinkBundle` does, and nothing is shown before it has.
 */
export const SharedCatalogLinkBundleSchema = z.strictObject({
  format: z.literal(CATALOG_LINK_BUNDLE_FORMAT),
  version: z.literal(1),
  signedLink: SignedCatalogLinkSchema,
  item: SharedCatalogItemSchema,
});
export type SharedCatalogLinkBundle = z.infer<typeof SharedCatalogLinkBundleSchema>;

// ── The bytes a signature covers ─────────────────────────────────────────────────────────────────

/** What a link signature signs: its own label, one zero byte, and the SHA-256 of the document's canonical JSON. */
export function catalogLinkSignedBytes(linkSha256: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(CATALOG_LINK_SIGNATURE_LABEL);
  const bytes = new Uint8Array(label.length + 1 + linkSha256.length);
  bytes.set(label, 0);
  bytes[label.length] = 0;
  bytes.set(linkSha256, label.length + 1);
  return bytes;
}
