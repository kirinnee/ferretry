/**
 * What this machine keeps about the people it shares catalogs with: `state/catalogs/members.json` and
 * `state/catalogs/shares.json` (docs/catalogs.md § Members, design §3.7).
 *
 * ## The code is not here
 *
 * A share keeps the SHA-256 of its code's text (`codeSha256`) and nothing else about it. A copy of
 * these files, a backup, or a stolen disk image therefore holds fingerprints that cannot be found from
 * by trying, never a code that could be spent. The only place a code ever exists is the mint's answer.
 *
 * ## Two files, one rule
 *
 * A member's catalogs and a share's catalogs are ids into `catalogs.json`; deleting a catalog removes
 * it from both (`CatalogMemberService.forgetCatalog`). What a read checks is each file on its own: its shape,
 * that no id or code is listed twice, and the size bounds. Whether a catalog id still exists is the SERVICE's
 * check, made at each commit against the catalogs the directory knows, never a trust in what the file says.
 */
import {
  CATALOG_MAX_KEYS_PER_MEMBER,
  CATALOG_MAX_MEMBER_KEYS,
  CATALOG_MAX_MEMBERS,
  CATALOG_SHARE_MAX_CATALOGS,
  CATALOG_SHARES_LISTED_MAX,
  CatalogMemberIdSchema,
  CatalogMemberKeyIdSchema,
  CatalogMemberLabelSchema,
  CatalogShareIdSchema,
  CatalogShareStateSchema,
  CatalogShareUsesSchema,
  InstantSchema,
  MemberClientNameSchema,
  memberNameKey,
  SharedCatalogIdSchema,
} from '@ferretry/protocol';
import { MemberBoxKeySchema, MemberKeySchema as WireMemberKeySchema } from '@ferretry/relay';
import { z } from 'zod';

export const CATALOG_MEMBERS_SCHEMA_VERSION = 1;
export const CATALOG_SHARES_SCHEMA_VERSION = 1;

/** The most successful joins and redeems a share remembers: its hourly count never needs more. */
export const SHARE_SUCCESS_WINDOW_MAX = 60;

const catalogIds = z
  .array(SharedCatalogIdSchema)
  .max(CATALOG_SHARE_MAX_CATALOGS)
  .refine(ids => new Set(ids).size === ids.length, 'each catalog is named once');

/**
 * One browser of a member. `passkeyCount` is how many member passkeys it registered (phase 2b-2 files the
 * credentials themselves); zero means it can do nothing but register one, until `passkeyWindowEndsAt`.
 */
const StoredMemberKeySchema = z.strictObject({
  keyId: CatalogMemberKeyIdSchema,
  /** The browser's Ed25519 key as SPKI base64url: the only thing a member session is opened with. */
  memberKey: WireMemberKeySchema,
  /** The browser's X25519 box key; phase 6 wraps members-only content to it. */
  boxKey: MemberBoxKeySchema,
  clientName: MemberClientNameSchema,
  joinedAt: InstantSchema,
  lastSeenAt: InstantSchema.optional(),
  passkeyCount: z.number().int().min(0).max(16),
  passkeyWindowEndsAt: InstantSchema.optional(),
});
export type StoredMemberKey = z.infer<typeof StoredMemberKeySchema>;

const StoredMemberSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  label: CatalogMemberLabelSchema,
  catalogIds,
  createdAt: InstantSchema,
  keys: z.array(StoredMemberKeySchema).max(CATALOG_MAX_KEYS_PER_MEMBER),
});
export type StoredMember = z.infer<typeof StoredMemberSchema>;

const MembersShapeSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_MEMBERS_SCHEMA_VERSION),
  members: z.array(StoredMemberSchema).max(CATALOG_MAX_MEMBERS),
});

/**
 * Every rule of the members file but one: two people may still share a name. ONLY the one-time upgrade reads a
 * file with this (docs/catalogs.md § Members): files written before a name was an ID can hold duplicates, and the
 * upgrade renames them before anything else sees the document.
 */
export const LegacyMembersDocumentSchema = MembersShapeSchema.check(ctx =>
  report(ctx, membersProblem(ctx.value, false)),
);

/** A member's name is their ID on this machine: no two are the same by {@link memberNameKey}. */
export const MembersDocumentSchema = MembersShapeSchema.check(ctx => report(ctx, membersProblem(ctx.value, true)));

function report(ctx: z.core.ParsePayload<z.infer<typeof MembersShapeSchema>>, message: string | undefined): void {
  if (message !== undefined) ctx.issues.push({ code: 'custom', message, input: ctx.value, path: ['members'] });
}

function membersProblem(document: z.infer<typeof MembersShapeSchema>, uniqueNames: boolean): string | undefined {
  const memberIds = new Set<string>();
  const keyIds = new Set<string>();
  const names = new Set<string>();
  let keys = 0;
  for (const member of document.members) {
    if (memberIds.has(member.memberId)) return `${member.memberId} is listed twice`;
    memberIds.add(member.memberId);
    if (uniqueNames) {
      const name = memberNameKey(member.label);
      if (names.has(name)) return `${member.memberId} has the same name as another member`;
      names.add(name);
    }
    for (const key of member.keys) {
      if (keyIds.has(key.keyId)) return `${key.keyId} is listed twice`;
      keyIds.add(key.keyId);
      keys += 1;
    }
  }
  if (keys > CATALOG_MAX_MEMBER_KEYS)
    return `it holds ${String(keys)} member keys; the most is ${String(CATALOG_MAX_MEMBER_KEYS)}`;
  return undefined;
}
export type MembersDocument = z.infer<typeof MembersDocumentSchema>;

export const EMPTY_MEMBERS_DOCUMENT: MembersDocument = { schemaVersion: CATALOG_MEMBERS_SCHEMA_VERSION, members: [] };

const StoredShareSchema = z.strictObject({
  shareId: CatalogShareIdSchema,
  /** Lowercase hex of the SHA-256 of the code's text. The code itself is never written anywhere. */
  codeSha256: z.string().regex(/^[0-9a-f]{64}$/u, 'a SHA-256 in lowercase hex'),
  memberId: CatalogMemberIdSchema,
  /** The member's name at mint, for a share whose member does not exist yet or has since gone. */
  memberLabel: CatalogMemberLabelSchema,
  /** `new`: the first join creates the member this share names. `existing`: the member was there at mint. */
  memberKind: z.enum(['new', 'existing']),
  catalogIds,
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
  uses: CatalogShareUsesSchema,
  /** How many uses are spent. A single-use share has 0 or 1. */
  used: z.number().int().min(0).max(1_000),
  state: CatalogShareStateSchema,
  usedBy: z
    .array(z.strictObject({ clientName: MemberClientNameSchema, keyId: CatalogMemberKeyIdSchema, at: InstantSchema }))
    .max(1_000),
  /** When this share's last successful joins and redeems happened, in ms, for its hourly count. */
  successes: z.array(z.number().int().min(0)).max(SHARE_SUCCESS_WINDOW_MAX),
});
export type StoredShare = z.infer<typeof StoredShareSchema>;

export const SharesDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(CATALOG_SHARES_SCHEMA_VERSION),
    shares: z.array(StoredShareSchema).max(CATALOG_SHARES_LISTED_MAX),
  })
  .check(ctx => {
    const issue = (message: string): void => {
      ctx.issues.push({ code: 'custom', message, input: ctx.value, path: ['shares'] });
    };
    const ids = new Set<string>();
    const hashes = new Set<string>();
    for (const share of ctx.value.shares) {
      if (ids.has(share.shareId)) return issue(`${share.shareId} is listed twice`);
      ids.add(share.shareId);
      if (hashes.has(share.codeSha256)) return issue(`${share.shareId} has the same code as another share`);
      hashes.add(share.codeSha256);
    }
  });
export type SharesDocument = z.infer<typeof SharesDocumentSchema>;

export const EMPTY_SHARES_DOCUMENT: SharesDocument = { schemaVersion: CATALOG_SHARES_SCHEMA_VERSION, shares: [] };

/** The first problem a failed parse found, worded for a person, or `null` when it parsed. */
export function documentProblem(parsed: { readonly success: boolean; readonly error?: z.ZodError }): string | null {
  if (parsed.success) return null;
  const first = parsed.error?.issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`;
  return `${first?.message ?? 'it is malformed'}${where}`;
}
