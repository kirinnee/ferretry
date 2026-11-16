/**
 * Catalogs' wire (§2.1): ids and the views other subsystems and the app read, copied field for field from today's
 * `packages/protocol/src/lib/{shared-catalog,catalog-member,shared-catalog-link,catalog-install}.ts`. The signed
 * document, draft, member-name and install-preview schemas are copied by the port with the code that answers them.
 *
 * A SHARE CODE IS A LIVE CREDENTIAL, like a pairing code: never logged, never persisted outside its hash.
 */
import { z } from 'zod';

// ─── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SharedCatalogIdSchema = z.string().regex(/^cat_[A-Za-z0-9_-]{22}$/u, 'invalid catalog id');
export type SharedCatalogId = z.infer<typeof SharedCatalogIdSchema>;

export const SharedCatalogItemIdSchema = z.string().regex(/^itm_[A-Za-z0-9_-]{22}$/u, 'invalid catalog item id');
export type SharedCatalogItemId = z.infer<typeof SharedCatalogItemIdSchema>;

export const CatalogMemberIdSchema = z.string().regex(/^mbr_[A-Za-z0-9_-]{22}$/u, 'invalid member id');
export type CatalogMemberId = z.infer<typeof CatalogMemberIdSchema>;

export const CatalogMemberKeyIdSchema = z.string().regex(/^mk_[A-Za-z0-9_-]{22}$/u, 'invalid member key id');
export type CatalogMemberKeyId = z.infer<typeof CatalogMemberKeyIdSchema>;

export const CatalogShareIdSchema = z.string().regex(/^shr_[A-Za-z0-9_-]{22}$/u, 'invalid share id');
export type CatalogShareId = z.infer<typeof CatalogShareIdSchema>;

/** A live credential: redeemed once by `POST /v1/shared/redeem`. Never logged. */
export const CatalogShareCodeSchema = z
  .string()
  .regex(/^fy_share_[A-Za-z0-9_-]{22}$/u, 'invalid share code')
  .brand<'CatalogShareCode'>();
export type CatalogShareCode = z.infer<typeof CatalogShareCodeSchema>;

export const CatalogLinkIdSchema = z.string().regex(/^lnk_[A-Za-z0-9_-]{22}$/u, 'invalid link id');
export const LinkBundleIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u, 'invalid link bundle id');

export const CatalogInstallPreviewIdSchema = z.string().regex(/^cip_[A-Za-z0-9_-]{22}$/u, 'invalid install preview id');
export const CatalogInstallIdSchema = z.string().regex(/^cin_[A-Za-z0-9_-]{22}$/u, 'invalid install id');
export type CatalogInstallId = z.infer<typeof CatalogInstallIdSchema>;

// ─── items and signatures ─────────────────────────────────────────────────────────────────────────────────────────

export const CatalogDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, 'expected sha256:<64 hex digits>');
export type CatalogDigest = z.infer<typeof CatalogDigestSchema>;

export const CATALOG_ITEM_KINDS = ['skill', 'mcp', 'artifact'] as const;
export const CatalogItemKindSchema = z.enum(CATALOG_ITEM_KINDS);
export type CatalogItemKind = z.infer<typeof CatalogItemKindSchema>;

export const CatalogHarnessSchema = z.enum(['claude', 'codex', 'generic']);

const base64UrlOf = (bytes: number) => {
  const length = Math.ceil((bytes * 4) / 3);
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`, 'u'), `expected ${bytes} bytes as base64url`);
};

/** The publisher's daemon identity (Ed25519 SPKI) and a signature over RFC 8785 canonical JSON. */
export const CatalogSpkiSchema = base64UrlOf(44);
export const CatalogSignatureSchema = base64UrlOf(64);

// ─── limits ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const MEMBER_JOIN_ATTEMPTS_PER_MINUTE = 10;
export const MEMBER_JOINS_PER_HOUR = 60;
export const CATALOG_SHARES_LISTED_MAX = 500;

// ─── the read model other plugins see ─────────────────────────────────────────────────────────────────────────────

/** One pinned install of a catalog item: what and which version, never the item's content. */
export const CatalogInstallSummarySchema = z.strictObject({
  id: CatalogInstallIdSchema,
  catalog: SharedCatalogIdSchema,
  item: SharedCatalogItemIdSchema,
  kind: CatalogItemKindSchema,
  digest: CatalogDigestSchema,
});
export type CatalogInstallSummary = z.infer<typeof CatalogInstallSummarySchema>;
