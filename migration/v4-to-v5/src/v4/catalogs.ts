/**
 * v4 catalog, share and install files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * Every shape below is v4's own record, field for field, made strict so a file 4.291.5 did not write is refused by
 * name instead of carried. Value bounds and the cross-record rules (`firstProblem`, unique member names) are v4's to
 * have enforced when it wrote the file; the converter re-checks only what joins files together (ids, digests, the
 * link-key names). Sources are `origin/main` (v4.291.5):
 *
 * - `state/catalogs/catalogs.json`: `lib/shared-catalogs/document.ts:62-247` (`CatalogsDocumentSchema`, `schemaVersion`
 *   3; version 2 is the same shape, upgraded on read by `upgradeCatalogsV2`; version 1 needs `migrate.ts`).
 * - `state/catalogs/blobs/<sha256 hex>.json`: `adapters/shared-catalogs/file-store.ts:86-120`, content-addressed.
 * - `state/catalogs/links.json`: `lib/catalog-links/document.ts:44-131` (`LinksDocumentSchema`, `schemaVersion` 1).
 * - `state/catalogs/link-keys.json`: `adapters/catalog-links/file-link-key-vault.ts` (SEALED: never opened here).
 * - `state/catalogs/members.json`, `shares.json`: `lib/catalog-members/document.ts:52-170` (`schemaVersion` 1).
 * - `state/catalogs/member-passkeys.json`: `StatePasskeyStore` with the member key id as `deviceId` (`fyd.ts:12670`).
 * - `state/catalogs/member-unlocks.json`: `StateUnlockLedger` (`fyd.ts:12683`), live unlocks only.
 * - `state/catalog-installs.json`: `lib/catalog-installs/store.ts:23-68` (`CatalogInstallStateSchema`, version 1).
 * - `state/catalog-install-prefs.json`: `lib/catalog-installs/prefs.ts:12-20`.
 * - `state/local-skill-installs.json`: `lib/local-skill-installs/store.ts:18-54` (`LocalSkillInstallStateSchema`).
 */
import { z } from 'zod';

export const V4_CATALOGS_DIR = 'state/catalogs';
export const V4_CATALOGS = 'state/catalogs/catalogs.json';
export const V4_CATALOG_BLOBS = 'state/catalogs/blobs';
export const V4_CATALOG_LINKS = 'state/catalogs/links.json';
export const V4_CATALOG_LINK_KEYS = 'state/catalogs/link-keys.json';
export const V4_CATALOG_MEMBERS = 'state/catalogs/members.json';
export const V4_CATALOG_SHARES = 'state/catalogs/shares.json';
export const V4_CATALOG_MEMBER_PASSKEYS = 'state/catalogs/member-passkeys.json';
export const V4_CATALOG_MEMBER_UNLOCKS = 'state/catalogs/member-unlocks.json';
export const V4_CATALOG_INSTALLS = 'state/catalog-installs.json';
export const V4_CATALOG_INSTALL_PREFS = 'state/catalog-install-prefs.json';
export const V4_LOCAL_SKILL_INSTALLS = 'state/local-skill-installs.json';
/** The vault key `link-keys.json` is sealed under (`FileSecretKey`, `paths.secretsKey`). */
export const V4_VAULT_KEY = 'state/secrets.key';

/** v4's upgrade backups (`paths.ts:161-167`): "kept once, never read". */
export const V4_CATALOG_BACKUPS = ['catalogs.v1.json', 'catalogs.v2.json', 'members.before-unique-names.json'] as const;

/** A frozen version's file name: the hex of its content digest (`FileCatalogBlobStore.fileOf`). */
export const V4_BLOB_NAME = /^([0-9a-f]{64})\.json$/u;

const instant = z.string().min(1);
const count = z.number().int();

// ─── catalogs.json ────────────────────────────────────────────────────────────────────────────────────────────────

const V4Binding = z.strictObject({ digest: z.string(), size: count });

const V4StoredVersion = z.strictObject({
  version: count,
  publishedAt: instant,
  summary: z.unknown(),
  source: z.unknown(),
  contentDigest: z.string(),
  size: count,
  fileCount: count.optional(),
  retiredAt: instant.optional(),
  bindings: z.record(z.string(), V4Binding),
});

const V4StoredItem = z.strictObject({
  itemId: z.string(),
  kind: z.enum(['skill', 'mcp']),
  name: z.string(),
  harness: z.enum(['claude', 'codex', 'generic']).optional(),
  ownSummary: z.boolean(),
  createdAt: instant,
  current: count,
  versions: z.array(V4StoredVersion).min(1),
});

const V4CatalogEntry = z.strictObject({
  itemId: z.string(),
  addedAt: instant,
  sinceVersion: count.optional(),
  joinedAtMax: count.optional(),
  withdrawnAt: instant.optional(),
});

const V4StoredCatalog = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  publisherName: z.string(),
  visibility: z.literal('members'),
  revision: count,
  issuedAt: instant,
  createdAt: instant,
  entries: z.array(V4CatalogEntry),
});

const catalogsDocument = <V extends number>(version: V) =>
  z.strictObject({
    schemaVersion: z.literal(version),
    defaultCatalogId: z.string().optional(),
    items: z.array(V4StoredItem),
    catalogs: z.array(V4StoredCatalog),
  });

/** Version 3, what 4.291.5 writes. */
export const V4CatalogsDocument = catalogsDocument(3);
/** Version 2: the same shape; v4's `upgradeCatalogsV2` changes only the number. */
export const V4CatalogsDocumentV2 = catalogsDocument(2);
export type V4Catalogs = z.infer<typeof V4CatalogsDocument>;

// ─── links.json ───────────────────────────────────────────────────────────────────────────────────────────────────

const V4PendingUpload = z.strictObject({
  sequence: count,
  version: count,
  notAfter: instant,
  expiresAt: instant.optional(),
  installCap: count.optional(),
  issuedAt: instant.optional(),
  revived: z.boolean().optional(),
});

export const V4StoredLink = z.strictObject({
  linkId: z.string(),
  itemId: z.string(),
  name: z.string(),
  itemKind: z.enum(['skill', 'mcp']),
  version: count,
  kind: z.enum(['one-time', 'public']),
  state: z.enum(['pending', 'live', 'ending', 'used', 'expired', 'ended']),
  createdAt: instant,
  expiresAt: instant.optional(),
  installCap: count.optional(),
  opens: count,
  opensCheckedAt: instant.optional(),
  bundleId: z.string(),
  publisher: z.string(),
  storeOrigin: z.string(),
  emitsStoreOrigin: z.boolean(),
  sequence: count,
  issuedAt: instant,
  notAfter: instant,
  servedSince: instant,
  keyRef: z.string().optional(),
  pendingUpload: V4PendingUpload.optional(),
  movedFrom: count.optional(),
  revivedAt: instant.optional(),
  endedAt: instant.optional(),
  endReason: z.enum(['owner', 'expired', 'used', 'item-gone', 'identity-changed']).optional(),
});
export type V4Link = z.infer<typeof V4StoredLink>;

export const V4LinksDocument = z.strictObject({ schemaVersion: z.literal(1), links: z.array(V4StoredLink) });

/** A link the store still serves or may serve (`isHeld`, `document.ts:94`): a public one keeps its key. */
export const isHeldLink = (link: V4Link): boolean =>
  link.state === 'pending' || link.state === 'live' || link.state === 'ending';

// ─── members.json, shares.json, member-passkeys.json ──────────────────────────────────────────────────────────────

const V4MemberKey = z.strictObject({
  keyId: z.string(),
  memberKey: z.string(),
  boxKey: z.string(),
  clientName: z.string(),
  joinedAt: instant,
  lastSeenAt: instant.optional(),
  passkeyCount: count,
  passkeyWindowEndsAt: instant.optional(),
});

const V4Member = z.strictObject({
  memberId: z.string(),
  label: z.string(),
  catalogIds: z.array(z.string()),
  createdAt: instant,
  keys: z.array(V4MemberKey),
});
export type V4MemberRecord = z.infer<typeof V4Member>;

export const V4MembersDocument = z.strictObject({ schemaVersion: z.literal(1), members: z.array(V4Member) });

const V4Share = z.strictObject({
  shareId: z.string(),
  codeSha256: z.string(),
  memberId: z.string(),
  memberLabel: z.string(),
  memberKind: z.enum(['new', 'existing']),
  catalogIds: z.array(z.string()),
  createdAt: instant,
  expiresAt: instant,
  uses: z.unknown(),
  used: count,
  state: z.string(),
  newPasskey: z.boolean().optional(),
  usedBy: z.array(z.strictObject({ clientName: z.string(), keyId: z.string(), at: instant })),
  successes: z.array(count),
});

export const V4SharesDocument = z.strictObject({ schemaVersion: z.literal(1), shares: z.array(V4Share) });

/** `memberNameKey` (`protocol/src/lib/catalog-member.ts:347`), verbatim: a member's name is their id on a machine. */
export function memberNameKey(name: string): string {
  const folded = name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase().toLowerCase();
  return folded.normalize('NFKC');
}

// ─── catalog-installs.json, catalog-install-prefs.json ────────────────────────────────────────────────────────────

const V4Provenance = z.strictObject({
  publisher: z.string(),
  publisherName: z.string(),
  catalogId: z.string(),
  catalogName: z.string(),
  itemId: z.string(),
  kind: z.enum(['skill', 'mcp', 'artifact']),
  name: z.string(),
  version: count,
  digest: z.string(),
});

const V4Target = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('project'), projectRoot: z.string(), harness: z.enum(['claude', 'codex']) }),
  z.strictObject({ scope: z.literal('runtime'), runtime: z.string(), profile: z.string() }),
]);
export type V4InstallTarget = z.infer<typeof V4Target>;

const V4CatalogInstall = z.strictObject({
  installId: z.string(),
  installedAt: instant,
  provenance: V4Provenance,
  target: V4Target,
  destination: z.string(),
  key: z.string(),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string(), entry: z.string().optional() })),
  secretBindings: z.record(z.string(), z.string().nullable()),
  root: z.string().optional(),
  folder: z.string().optional(),
  componentSha256: z.string().optional(),
});

export const V4CatalogInstallsDocument = z.strictObject({
  schemaVersion: z.literal(1),
  installs: z.array(V4CatalogInstall),
  publishers: z.record(z.string(), instant),
  pins: z.record(z.string(), z.string()),
  revisions: z.record(z.string(), count),
});

export const V4CatalogInstallPrefsDocument = z.strictObject({
  schemaVersion: z.literal(1),
  installs: z.record(
    z.string(),
    z.strictObject({ hold: z.literal(true).optional(), skippedVersion: count.optional() }),
  ),
});

// ─── local-skill-installs.json ────────────────────────────────────────────────────────────────────────────────────

const V4LocalSkillInstall = z.strictObject({
  installId: z.string(),
  installedAt: instant,
  name: z.string(),
  origin: z.strictObject({
    kind: z.enum(['account', 'project']),
    owner: z.string(),
    harness: z.enum(['claude', 'codex']),
    path: z.string(),
  }),
  provenance: V4Provenance,
  target: V4Target,
  destination: z.string(),
  key: z.string(),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
  root: z.string().optional(),
  folder: z.string().optional(),
  componentSha256: z.string().optional(),
});

export const V4LocalSkillInstallsDocument = z.strictObject({
  schemaVersion: z.literal(1),
  installs: z.array(V4LocalSkillInstall),
});
