/**
 * Links, the URL and the owner's wire (docs/catalogs.md § Links).
 *
 * A link is ONE skill or MCP setup, sealed with a key that lives only in the URL's fragment and stored
 * encrypted at a link store. This file holds what a person sees and a daemon's owner routes say:
 *
 * - the `/get#v1;b=…;k=…;fp=…` fragment, and the readers that refuse it as a pairing or share link;
 * - the owner's request and answer schemas (`/v1/catalog-links`);
 * - the sentences said beside a link.
 *
 * The signed document is `shared-catalog-link.ts`, the sealing and the store wire are in `@ferretry/relay`.
 * Nothing here is built into a route yet (catalogs 3f-1 is the libraries only).
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema, readLinkFragmentFields } from './pairing.ts';
import { CatalogItemSourceSchema, CatalogSourceProblemSchema } from './shared-catalog-owner.ts';
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';
import {
  CatalogDigestSchema,
  CatalogItemNameSchema,
  CatalogSummarySchema,
  SharedCatalogItemIdSchema,
} from './shared-catalog.ts';
import {
  CatalogLinkIdSchema,
  CatalogLinkKindSchema,
  LinkBundleIdSchema,
  LinkKeySchema,
} from './shared-catalog-link.ts';

// ── The URL ──────────────────────────────────────────────────────────────────────────────────────

/** The app's page for a link. Routed by PATH, so a pairing or share reader is never handed one. */
export const GET_LINK_PATH = '/get' as const;

/** What a link URL carries: where to find the envelope, the key that opens it, and who must have signed it. */
export interface CatalogLinkSeed {
  readonly bundleId: z.infer<typeof LinkBundleIdSchema>;
  readonly key: z.infer<typeof LinkKeySchema>;
  readonly publisher: z.infer<typeof DaemonIdSchema>;
  /**
   * The origin of a self-hosted link store, only when the publisher uses one. Absent means the store the app
   * discovers itself, so the hosted store keeps working if its directory moves.
   */
  readonly storeOrigin?: string;
}

/**
 * A link fragment, for surfaces that gate before parsing: `v1` with a `k=` field. A pairing fragment
 * (`PAIRING_FRAGMENT_PATTERN`, any `v1`) also admits it, so a surface ROUTES BY PATH and only then gates.
 */
export const LINK_FRAGMENT_PATTERN = /^#?v1;(?:[^;]*;)*k=/u;

/** Why a link store address cannot be used, or `null` when it can: an `https:` origin, nothing after the host. */
export function linkStoreOriginProblem(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'the link store address is not an address';
  }
  if (url.protocol !== 'https:') return 'the link store address is not an https address';
  if (url.username !== '' || url.password !== '') return 'the link store address carries a user name or password';
  if (url.origin !== address) return 'the link store address is more than a host';
  return null;
}

/**
 * Writes the one fragment form for one link: `v1;b=…;k=…;fp=…` and, only for a self-hosted store, `;s=…`.
 * Everything a fetch needs and nothing a machine could be reached by: no address, no code. The key never
 * enters a path or a query, so a link-preview fetcher never sees it.
 */
export function formatLinkFragment(seed: CatalogLinkSeed): string {
  const bundleId = LinkBundleIdSchema.parse(seed.bundleId);
  const key = LinkKeySchema.parse(seed.key);
  const publisher = DaemonIdSchema.parse(seed.publisher);
  const head = `v1;b=${bundleId};k=${key};fp=${encodeURIComponent(publisher)}`;
  if (seed.storeOrigin === undefined) return head;
  const problem = linkStoreOriginProblem(seed.storeOrigin);
  if (problem !== null) throw new Error(problem);
  return `${head};s=${encodeURIComponent(seed.storeOrigin)}`;
}

/** The full link: the app's `/get` page with the fragment. */
export function catalogLinkUrl(appOrigin: string, seed: CatalogLinkSeed): string {
  const url = new URL(GET_LINK_PATH, appOrigin);
  url.hash = formatLinkFragment(seed);
  return url.toString();
}

/**
 * Reads a link fragment back, or throws the reason it cannot. The SAME field reader as a pairing or share
 * link (`readLinkFragmentFields`): an unrecognised field is ignored, a repeated one refused. Three names are
 * refused rather than ignored — `code` (pairing), `share` (share) and `url` (either names a machine) — so a
 * fragment that is two kinds of link is read by neither reader, and a link can never be made to name an
 * address the app would dial.
 */
export function parseLinkFragment(fragment: string): CatalogLinkSeed {
  const fields = readLinkFragmentFields(fragment, 'download link');
  if (fields.has('code')) throw new Error('this is a pairing link, not a download link');
  if (fields.has('share')) throw new Error('this is a share link, not a download link');
  if (fields.has('url')) throw new Error('a download link names no machine address');
  const bundleId = fields.get('b');
  const key = fields.get('k');
  const fingerprint = fields.get('fp');
  if (bundleId === undefined || key === undefined || fingerprint === undefined)
    throw new Error('download link must include b, k and fp');
  const parsedBundle = LinkBundleIdSchema.safeParse(bundleId);
  if (!parsedBundle.success) throw new Error('download link carries an invalid bundle id');
  const parsedKey = LinkKeySchema.safeParse(key);
  if (!parsedKey.success) throw new Error('download link carries an invalid key');
  const parsedPublisher = DaemonIdSchema.safeParse(fingerprint);
  if (!parsedPublisher.success) throw new Error('download link carries an invalid fingerprint');
  const storeOrigin = fields.get('s');
  if (storeOrigin === undefined)
    return { bundleId: parsedBundle.data, key: parsedKey.data, publisher: parsedPublisher.data };
  const problem = linkStoreOriginProblem(storeOrigin);
  if (problem !== null) throw new Error(`download link: ${problem}`);
  return { bundleId: parsedBundle.data, key: parsedKey.data, publisher: parsedPublisher.data, storeOrigin };
}

// ── What a person is told ────────────────────────────────────────────────────────────────────────

/** Said where a public link is made or opened. */
export const PUBLIC_LINK_NOTICE = 'Anyone with this link can install it.';
/** Said where a one-time link is made or opened. */
export const ONE_TIME_LINK_NOTICE = 'This link works once. Opening it uses it up.';
/** The refusal when the sealed bundle is over the store's cap. */
export const LINK_TOO_BIG_SENTENCE = 'This is too large to share as a link. Export it as a file instead.';

// ── Expiry and caps ──────────────────────────────────────────────────────────────────────────────

export const CATALOG_LINK_EXPIRIES = ['15m', '1h', '3h', '8h', '1d', '7d', '30d', 'never'] as const;
export const CatalogLinkExpirySchema = z.enum(CATALOG_LINK_EXPIRIES);
export type CatalogLinkExpiry = z.infer<typeof CatalogLinkExpirySchema>;

/** A one-time link ends within a day, as a share code does; the default is an hour. */
export const ONE_TIME_LINK_EXPIRIES = ['15m', '1h', '3h', '8h', '1d'] as const satisfies readonly CatalogLinkExpiry[];
export const ONE_TIME_LINK_DEFAULT_EXPIRY = '1h' as const satisfies CatalogLinkExpiry;
/** A public link may have no end; the default is a week. */
export const PUBLIC_LINK_EXPIRIES = ['1d', '7d', '30d', 'never'] as const satisfies readonly CatalogLinkExpiry[];
export const PUBLIC_LINK_DEFAULT_EXPIRY = '7d' as const satisfies CatalogLinkExpiry;

/** How long each choice lasts, in milliseconds; `never` has no end. */
export const CATALOG_LINK_EXPIRY_MS: Readonly<Record<CatalogLinkExpiry, number | null>> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  never: null,
};

/** Most live links one machine keeps; the store holds the same number. */
export const CATALOG_LINKS_MAX_LIVE = 50;
/** The largest cap on how many times a public link may be opened. */
export const CATALOG_LINK_INSTALL_CAP_MAX = 10_000;

const InstallCapSchema = z.number().int().min(1).max(CATALOG_LINK_INSTALL_CAP_MAX);

// ── The owner's wire ─────────────────────────────────────────────────────────────────────────────

export const CATALOG_LINKS_PATH = '/v1/catalog-links' as const;

/** Why an owner route refused. Each is a different sentence for the person. */
export const CATALOG_LINK_REFUSALS = [
  'links_store_damaged',
  'link_unknown',
  'item_unknown',
  'version_unknown',
  'source_unknown',
  'source_ambiguous',
  'source_refused',
  'item_source_changed',
  'changed_since_preview',
  'link_kind_unsupported',
  'links_full',
  'version_retired',
  'version_linked',
  'link_too_big',
  'link_not_public',
  'link_not_live',
  'current_changed',
  'nothing_to_publish',
  'link_store_unavailable',
  'signing_unavailable',
] as const;
export const CatalogLinkRefusalSchema = z.enum(CATALOG_LINK_REFUSALS);
export type CatalogLinkRefusal = z.infer<typeof CatalogLinkRefusalSchema>;

/** What a link serves: one exact version of one item, by the digest the preview showed. */
const ItemByVersionSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  version: z.number().int().min(1),
  digest: CatalogDigestSchema,
});

/**
 * `POST /v1/catalog-links` body. The item is a kept version, or a source not yet kept (a new unlisted item is
 * made, no catalog lists it). The `digest` is the preview's: the daemon re-checks it, so what is signed is what
 * was reviewed. One-time and public links have different ends, and only a public link has a cap.
 */
export const CreateCatalogLinkRequestSchema = z
  .strictObject({
    item: z.union([
      ItemByVersionSchema,
      z.strictObject({
        source: CatalogItemSourceSchema,
        digest: CatalogDigestSchema,
        summary: CatalogSummarySchema.optional(),
      }),
    ]),
    kind: CatalogLinkKindSchema,
    expires: CatalogLinkExpirySchema,
    installCap: InstallCapSchema.optional(),
  })
  .check(ctx => {
    const { kind, expires, installCap } = ctx.value;
    const allowed: readonly CatalogLinkExpiry[] = kind === 'one-time' ? ONE_TIME_LINK_EXPIRIES : PUBLIC_LINK_EXPIRIES;
    if (!allowed.includes(expires))
      ctx.issues.push({
        code: 'custom',
        message: kind === 'one-time' ? 'a one-time link ends within a day' : 'a public link ends in a day or more',
        input: ctx.value,
        path: ['expires'],
      });
    if (kind === 'one-time' && installCap !== undefined)
      ctx.issues.push({
        code: 'custom',
        message: 'only a public link has a cap',
        input: ctx.value,
        path: ['installCap'],
      });
  });
export type CreateCatalogLinkRequest = z.infer<typeof CreateCatalogLinkRequestSchema>;

/** `POST /v1/catalog-links/preview` body: nothing is written. */
export const CatalogLinkPreviewRequestSchema = z.union([
  z.strictObject({ itemId: SharedCatalogItemIdSchema, version: z.number().int().min(1) }),
  z.strictObject({ source: CatalogItemSourceSchema }),
]);
export type CatalogLinkPreviewRequest = z.infer<typeof CatalogLinkPreviewRequestSchema>;

/** `PUT /v1/catalog-links/:linkId/version` body: move a public link to another version. */
export const MoveCatalogLinkRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  /** The version the link serves now, so a move made from a stale screen is refused `current_changed`. */
  from: z.number().int().min(1),
  digest: CatalogDigestSchema,
});
export type MoveCatalogLinkRequest = z.infer<typeof MoveCatalogLinkRequestSchema>;

/** `PATCH /v1/catalog-links/:linkId` body: the end and the cap of a public link. A `null` cap removes it. */
export const UpdateCatalogLinkRequestSchema = z
  .strictObject({
    expires: z.enum(PUBLIC_LINK_EXPIRIES).optional(),
    installCap: InstallCapSchema.nullable().optional(),
  })
  .refine(body => body.expires !== undefined || body.installCap !== undefined, 'say what to change');
export type UpdateCatalogLinkRequest = z.infer<typeof UpdateCatalogLinkRequestSchema>;

export const CATALOG_LINK_STATES = ['pending', 'live', 'ending', 'used', 'expired', 'ended'] as const;
export const CatalogLinkStateSchema = z.enum(CATALOG_LINK_STATES);
export type CatalogLinkState = z.infer<typeof CatalogLinkStateSchema>;

/**
 * One link as its owner sees it. NO URL, NO KEY, NO BUNDLE ID and no store address: the only wire that
 * carries a URL is {@link CreatedCatalogLinkSchema} (once) and {@link CatalogLinkUrlSchema} (Copy). `opens` is
 * what the store counts — how many times the bundle was fetched, not how many installs followed.
 */
export const OwnedCatalogLinkSchema = z.strictObject({
  linkId: CatalogLinkIdSchema,
  itemId: SharedCatalogItemIdSchema,
  name: CatalogItemNameSchema,
  itemKind: z.enum(['skill', 'mcp']),
  version: z.number().int().min(1),
  kind: CatalogLinkKindSchema,
  state: CatalogLinkStateSchema,
  createdAt: InstantSchema,
  /** When the version it serves now was uploaded. */
  servedSince: InstantSchema,
  expiresAt: InstantSchema.optional(),
  installCap: InstallCapSchema.optional(),
  opens: z.number().int().min(0),
  opensCheckedAt: InstantSchema.optional(),
  storeState: z.enum(['ok', 'unreachable']).optional(),
  endedAt: InstantSchema.optional(),
});
export type OwnedCatalogLink = z.infer<typeof OwnedCatalogLinkSchema>;

export const OwnedCatalogLinkListSchema = z.strictObject({
  publisher: DaemonIdSchema,
  links: z.array(OwnedCatalogLinkSchema).readonly(),
  max: z.literal(CATALOG_LINKS_MAX_LIVE),
});
export type OwnedCatalogLinkList = z.infer<typeof OwnedCatalogLinkListSchema>;

/** `POST /v1/catalog-links` answer: the one place a fresh URL is shown. A one-time URL is never shown again. */
export const CreatedCatalogLinkSchema = z.strictObject({ link: OwnedCatalogLinkSchema, url: z.string().min(1) });
export type CreatedCatalogLink = z.infer<typeof CreatedCatalogLinkSchema>;

/** `POST /v1/catalog-links/:linkId/copy` answer: a public link's URL again. */
export const CatalogLinkUrlSchema = z.strictObject({ url: z.string().min(1) });
export type CatalogLinkUrl = z.infer<typeof CatalogLinkUrlSchema>;

/** `GET /v1/catalog-links/store` answer: whether a link can be made now, asked before a passkey is. */
export const CatalogLinkStoreStatusSchema = z.strictObject({
  available: z.boolean(),
  /** The store's address, only when it is not the hosted one. */
  origin: z.string().min(1).optional(),
  sentence: z.string().min(1),
});
export type CatalogLinkStoreStatus = z.infer<typeof CatalogLinkStoreStatusSchema>;

/**
 * `POST /v1/catalog-links/preview` answer: the frozen review, written to nothing. `envelopeBytes` is the size
 * of the sealed envelope, measured BEFORE a passkey is asked; `tooBig` is whether the store would refuse it.
 */
export const CatalogLinkPreviewSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema.optional(),
  version: z.number().int().min(1).optional(),
  /** True when the source is not a kept item: minting would make a new unlisted one. */
  newItem: z.boolean(),
  name: CatalogItemNameSchema,
  itemKind: z.enum(['skill', 'mcp']),
  summary: CatalogSummarySchema,
  review: z.array(CatalogReviewEntrySchema).readonly(),
  warnings: z.array(CatalogInstallWarningSchema).readonly(),
  problems: z.array(CatalogSourceProblemSchema).readonly(),
  location: z.string().max(4_096).optional(),
  digest: CatalogDigestSchema,
  envelopeBytes: z.number().int().min(0),
  tooBig: z.boolean(),
});
export type CatalogLinkPreview = z.infer<typeof CatalogLinkPreviewSchema>;
