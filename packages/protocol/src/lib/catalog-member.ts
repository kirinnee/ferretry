/**
 * Members: the people a catalog is shared with (docs/catalogs.md § Members; design §1, §2.1–2.3, §3.1,
 * §3.2, §3.4). This file is the wire for phase 2: the share an owner mints, the member it creates, what a
 * joining browser is told, and what a member may ask for. The session records that carry a join and a
 * member's proof are `@ferretry/relay`'s `member-session.ts`; their contract is docs/relay-protocol.md §14
 * "Member sessions".
 *
 * ## A member is a person, not a device
 *
 * The owner names a member ("Alice", "Workshop Oct 31"). A member holds READ grants on chosen catalogs
 * and nothing else: no capability, no unlock of the machine, no step-up for anything on it, no place in
 * `state/devices.json`. One member may have many browsers; each is a member KEY the browser made and can
 * never export, plus that browser's own passkey. A browser can be a paired device of a machine AND a member
 * of it at once — two keys in two stores, neither ever standing in for the other.
 *
 * ## The code is shown once and kept as a hash
 *
 * {@link CatalogShareMintResponseSchema} is the ONLY schema here with a field for a share code, and it is
 * answered exactly once, to the owner who minted it. The publisher keeps only the code's SHA-256. No view,
 * list or audit event has a field for it (`tests/unit/catalog-member.test.ts` walks every schema).
 */
import { z } from 'zod';
import { PublishedCarriersSchema } from './carriers.ts';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema, DaemonNameSchema } from './pairing.ts';
import { CatalogLabelSchema, SharedCatalogIdSchema } from './shared-catalog.ts';

export const CATALOG_SHARES_PATH = '/v1/catalog-shares' as const;
export const CATALOG_MEMBERS_PATH = '/v1/catalog-members' as const;
/** The member route table: a SEPARATE table only a member session reaches (design §3.4). */
export const SHARED_PATH = '/v1/shared' as const;
/** Where a share link opens in the app. A pairing link opens elsewhere, and neither reader accepts the other. */
export const SHARE_LINK_PATH = '/join' as const;

// ── Bounds (design §3.1, owner decisions Q3, Q4, Q13) ────────────────────────────────────────────

/** The sharer picks one (owner decision 2026-10-31). Nothing longer: a lasting link is what public catalogs are for. */
export const CATALOG_SHARE_EXPIRIES = ['15m', '1h', '3h', '8h', '1d'] as const;
export const CatalogShareExpirySchema = z.enum(CATALOG_SHARE_EXPIRIES);
export type CatalogShareExpiry = z.infer<typeof CatalogShareExpirySchema>;
export const CATALOG_SHARE_EXPIRY_SECONDS: Readonly<Record<CatalogShareExpiry, number>> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '3h': 3 * 60 * 60,
  '8h': 8 * 60 * 60,
  '1d': 24 * 60 * 60,
};

/** A multi-use code's cap: how many browsers may join through it before it ends. */
export const CATALOG_SHARE_MULTI_CAP_DEFAULT = 50;
export const CATALOG_SHARE_MULTI_CAP_MAX = 500;
/** How many catalogs one share may grant. */
export const CATALOG_SHARE_MAX_CATALOGS = 64;
/** Live (unspent, unexpired) shares at once. */
export const CATALOG_MAX_LIVE_SHARES = 64;

export const CATALOG_MAX_MEMBERS = 128;
/** Browsers across every member. A full publisher refuses a join and LEAVES THE CODE LIVE, as a full pairing does. */
export const CATALOG_MAX_MEMBER_KEYS = 512;

/** After a join, the new key may register its passkey for this long and do nothing else (zero-trust B2). */
export const MEMBER_PASSKEY_WINDOW_SECONDS = 600;
/** One member unlock lasts this many days (owner decision Q4): a member only reads. */
export const MEMBER_UNLOCK_DAYS_DEFAULT = 30;
export const MEMBER_UNLOCK_DAYS_MIN = 1;
export const MEMBER_UNLOCK_DAYS_MAX = 90;
/** A member key nobody used for this long is removed, like an idle device; the member stays. */
export const MEMBER_KEY_IDLE_EXPIRY_DAYS = 90;

/** Join attempts per minute per carrier and peer (relayed: per rendezvous session, as pairing). */
export const MEMBER_JOIN_ATTEMPTS_PER_MINUTE = 10;
/** Joins per hour per publisher, whatever the carrier. */
export const MEMBER_JOINS_PER_HOUR = 60;

// ── Identifiers ──────────────────────────────────────────────────────────────────────────────────

/** `mbr_` and 22 base64url characters: 128 random bits. A member is a person the owner named. */
export const CatalogMemberIdSchema = z.string().regex(/^mbr_[A-Za-z0-9_-]{22}$/u, 'invalid member id');
export type CatalogMemberId = z.infer<typeof CatalogMemberIdSchema>;

/** `mk_` and 22 base64url characters: one browser's key for one member. */
export const CatalogMemberKeyIdSchema = z.string().regex(/^mk_[A-Za-z0-9_-]{22}$/u, 'invalid member key id');
export type CatalogMemberKeyId = z.infer<typeof CatalogMemberKeyIdSchema>;

/** `shr_` and 22 base64url characters: one invitation. Not the code. */
export const CatalogShareIdSchema = z.string().regex(/^shr_[A-Za-z0-9_-]{22}$/u, 'invalid share id');
export type CatalogShareId = z.infer<typeof CatalogShareIdSchema>;

/**
 * A share code: `fy_share_` and 22 base64url characters, 128 random bits. Long enough that guessing is not
 * an attack (so its rate limit only stops floods), and prefixed so a chat or a code host's secret scanner
 * can recognise a leaked one. It cannot be read as a pairing code, nor a pairing code as it.
 */
export const CatalogShareCodeSchema = z
  .string()
  .regex(/^fy_share_[A-Za-z0-9_-]{22}$/u, 'invalid share code')
  .brand<'CatalogShareCode'>();
export type CatalogShareCode = z.infer<typeof CatalogShareCodeSchema>;

/** A member's name, as the owner wrote it ("Alice", "Workshop Oct 31"). The catalog label's rules. */
export const CatalogMemberLabelSchema = CatalogLabelSchema;

/** What the joining browser calls itself ("Firefox on a Mac"). Shown to the owner; never trusted. */
export const MemberClientNameSchema = CatalogLabelSchema;

// ── The owner's side (routes on A, `sharing.use`) ────────────────────────────────────────────────

/** Who a share is for: a new person the owner names, or a member who already exists. */
export const CatalogShareMemberSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), label: CatalogMemberLabelSchema }),
  z.strictObject({ kind: z.literal('existing'), memberId: CatalogMemberIdSchema }),
]);
export type CatalogShareMember = z.infer<typeof CatalogShareMemberSchema>;

/**
 * Single use: the code burns on its first redemption. Multi use: it ends at its expiry, at its cap, or
 * when the owner ends it, and every browser joins the ONE member the share names (owner decision Q3).
 */
export const CatalogShareUsesSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('single') }),
  z.strictObject({
    kind: z.literal('multi'),
    cap: z.number().int().min(2).max(CATALOG_SHARE_MULTI_CAP_MAX),
  }),
]);
export type CatalogShareUses = z.infer<typeof CatalogShareUsesSchema>;

const distinctCatalogs = z
  .array(SharedCatalogIdSchema)
  .min(1)
  .max(CATALOG_SHARE_MAX_CATALOGS)
  .refine(ids => new Set(ids).size === ids.length, 'each catalog is named once');

/**
 * `POST /v1/catalog-shares`: mint one share. A governed caller confirms with a passkey proved for this
 * act alone (`share-catalog`), as minting a pairing code does: it adds access.
 */
export const CatalogShareMintRequestSchema = z
  .strictObject({
    catalogIds: distinctCatalogs,
    member: CatalogShareMemberSchema,
    expiresIn: CatalogShareExpirySchema,
    uses: CatalogShareUsesSchema,
  })
  .refine(
    request => request.uses.kind === 'single' || request.member.kind === 'new',
    'a code for many people makes its own member: name it',
  );
export type CatalogShareMintRequest = z.infer<typeof CatalogShareMintRequestSchema>;

export const CatalogShareStateSchema = z.enum(['live', 'spent', 'expired', 'ended']);
export type CatalogShareState = z.infer<typeof CatalogShareStateSchema>;

/** One share, as the owner's lists show it. It never carries the code. */
export const CatalogShareViewSchema = z.strictObject({
  shareId: CatalogShareIdSchema,
  memberId: CatalogMemberIdSchema,
  memberLabel: CatalogMemberLabelSchema,
  catalogIds: z.array(SharedCatalogIdSchema).max(CATALOG_SHARE_MAX_CATALOGS),
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
  uses: CatalogShareUsesSchema,
  state: CatalogShareStateSchema,
  /** Who used it, newest last: the browser's own name for itself and when. A multi-use code lists each. */
  usedBy: z
    .array(z.strictObject({ clientName: MemberClientNameSchema, keyId: CatalogMemberKeyIdSchema, at: InstantSchema }))
    .max(CATALOG_SHARE_MULTI_CAP_MAX),
});
export type CatalogShareView = z.infer<typeof CatalogShareViewSchema>;

/**
 * The answer to a mint, given ONCE: the code, and the link that carries it in its fragment. The publisher
 * keeps only the code's SHA-256, so there is nothing to show again — a lost code is ended and minted anew.
 */
export const CatalogShareMintResponseSchema = z.strictObject({
  share: CatalogShareViewSchema,
  code: CatalogShareCodeSchema,
  /** `https://<app>/join#v1;url=…;fp=…;share=…` — {@link formatShareFragment}. */
  link: z
    .string()
    .max(2_048)
    .regex(/^https?:\/\/[^\s#]+#v1;/u, 'a share link'),
});
export type CatalogShareMintResponse = z.infer<typeof CatalogShareMintResponseSchema>;

export const CatalogShareListSchema = z.strictObject({ shares: z.array(CatalogShareViewSchema) });
export type CatalogShareList = z.infer<typeof CatalogShareListSchema>;

/** One browser of a member, as the owner sees it. */
export const CatalogMemberKeyViewSchema = z.strictObject({
  keyId: CatalogMemberKeyIdSchema,
  clientName: MemberClientNameSchema,
  joinedAt: InstantSchema,
  lastSeenAt: InstantSchema.optional(),
  /** How many passkeys this browser registered. Zero means it can do nothing but register one. */
  passkeys: z.number().int().min(0).max(16),
  /** Open while the new key may still register its passkey; absent once it closed. */
  passkeyWindowEndsAt: InstantSchema.optional(),
});
export type CatalogMemberKeyView = z.infer<typeof CatalogMemberKeyViewSchema>;

/** `GET /v1/catalog-members`: a person, the catalogs they may read, and each of their browsers. */
export const CatalogMemberViewSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  label: CatalogMemberLabelSchema,
  catalogIds: z.array(SharedCatalogIdSchema).max(CATALOG_SHARE_MAX_CATALOGS),
  createdAt: InstantSchema,
  keys: z.array(CatalogMemberKeyViewSchema).max(CATALOG_MAX_MEMBER_KEYS),
});
export type CatalogMemberView = z.infer<typeof CatalogMemberViewSchema>;

export const CatalogMemberListSchema = z.strictObject({
  members: z.array(CatalogMemberViewSchema).max(CATALOG_MAX_MEMBERS),
});
export type CatalogMemberList = z.infer<typeof CatalogMemberListSchema>;

// ── The joining browser ──────────────────────────────────────────────────────────────────────────

/**
 * What a browser is told the one moment its join succeeded, inside the sealed `joined` record. Like the
 * pairing response it has no field for a key, a proof or a fingerprint, and it is embedded WHOLE so the
 * next field added here crosses a relay the day it ships.
 */
export const MemberJoinedResponseSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  keyId: CatalogMemberKeyIdSchema,
  label: CatalogMemberLabelSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
  catalogs: z
    .array(z.strictObject({ catalogId: SharedCatalogIdSchema, name: CatalogLabelSchema }))
    .max(CATALOG_SHARE_MAX_CATALOGS),
  carriers: PublishedCarriersSchema.default([]),
  /** The new key must register its passkey before this; after it, the key is useless until the owner re-opens it. */
  passkeyWindowEndsAt: InstantSchema,
  memberUnlockDays: z.number().int().min(MEMBER_UNLOCK_DAYS_MIN).max(MEMBER_UNLOCK_DAYS_MAX),
});
export type MemberJoinedResponse = z.infer<typeof MemberJoinedResponseSchema>;

// ── The member route table (`/v1/shared/*`, a member session only) ──────────────────────────────

/** `GET /v1/shared/me`: who this browser is here, what it may read now, and whether it is unlocked. */
export const SharedMeSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  keyId: CatalogMemberKeyIdSchema,
  label: CatalogMemberLabelSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
  catalogs: z
    .array(
      z.strictObject({ catalogId: SharedCatalogIdSchema, name: CatalogLabelSchema, revision: z.number().int().min(1) }),
    )
    .max(CATALOG_SHARE_MAX_CATALOGS),
  carriers: PublishedCarriersSchema.default([]),
  /** A member session that is not unlocked reaches only the unlock and passkey routes. */
  unlocked: z.boolean(),
  unlockExpiresAt: InstantSchema.optional(),
  passkeys: z.number().int().min(0).max(16),
});
export type SharedMe = z.infer<typeof SharedMeSchema>;

/**
 * `POST /v1/shared/redeem`: a browser that already belongs to a member spends a code (design §2.3). The
 * publisher BURNS the code first, whatever happens next, so no answer can leave it alive for somebody else.
 */
export const SharedRedeemRequestSchema = z.strictObject({ code: CatalogShareCodeSchema });
export type SharedRedeemRequest = z.infer<typeof SharedRedeemRequestSchema>;

export const SharedRedeemResponseSchema = z.strictObject({
  /** Catalogs this member gained by the code; empty when it already held them all. */
  added: z
    .array(z.strictObject({ catalogId: SharedCatalogIdSchema, name: CatalogLabelSchema }))
    .max(CATALOG_SHARE_MAX_CATALOGS),
});
export type SharedRedeemResponse = z.infer<typeof SharedRedeemResponseSchema>;

/**
 * Why a share step was refused. A JOIN is never told any of these: every join failure is one generic
 * `join-refused` record (docs/relay-protocol.md §14). These answer an authenticated member or the owner.
 *
 * - `share_refused`: the code is unknown, spent, expired or ended — one answer for all four.
 * - `share_other_member`: the code was minted for a different member; it is burned and the owner is told
 *   (owner decision Q5). A browser is one member per publisher.
 * - `share_new_member`: the code makes a new member, and this browser already is one here.
 * - `members_full`: the publisher holds its most members or keys; the code is left live.
 * - `member_unknown`, `member_key_unknown`, `catalog_unknown`, `share_unknown`: the owner named an id this
 *   publisher does not have.
 */
export const CATALOG_SHARE_REFUSALS = [
  'share_refused',
  'share_other_member',
  'share_new_member',
  'members_full',
  'member_unknown',
  'member_key_unknown',
  'catalog_unknown',
  'share_unknown',
] as const;
export const CatalogShareRefusalSchema = z.enum(CATALOG_SHARE_REFUSALS);
export type CatalogShareRefusal = z.infer<typeof CatalogShareRefusalSchema>;

// ── The share link ───────────────────────────────────────────────────────────────────────────────

/** What a share link carries: the publisher's address, its fingerprint, and the code — in the fragment only. */
export interface ShareLinkSeed {
  readonly daemonUrl: string;
  readonly daemonId: z.infer<typeof DaemonIdSchema>;
  readonly code: CatalogShareCode;
}

/** A share fragment, for surfaces that gate before parsing. Admits exactly the version the parser reads. */
export const SHARE_FRAGMENT_PATTERN = /^#?v1(?:;|$)/u;

/**
 * Writes the one fragment form for one share: `v1;url=…;fp=…;share=…`. The pairing fragment's grammar
 * (`docs/pairing.md`), with the code under its OWN field name, `share`, so a pairing reader handed a
 * share link refuses it for lacking `code`, and this reader refuses a pairing link for lacking `share`.
 * The code never enters a path or a query: a link preview fetcher never sees a fragment.
 */
export function formatShareFragment(seed: ShareLinkSeed): string {
  const code = CatalogShareCodeSchema.parse(seed.code);
  const daemonId = DaemonIdSchema.parse(seed.daemonId);
  return `v1;url=${encodeURIComponent(seed.daemonUrl)};fp=${encodeURIComponent(daemonId)};share=${code}`;
}

/** The full share link: the app's `/join` page with the fragment. */
export function shareLinkUrl(appOrigin: string, seed: ShareLinkSeed): string {
  const url = new URL(SHARE_LINK_PATH, appOrigin);
  url.hash = formatShareFragment(seed);
  return url.toString();
}

/**
 * Reads a share fragment back, or throws the reason it cannot. Pairing's tolerance rules: an unrecognised
 * field is IGNORED (the next version arriving), a repeated one is REFUSED (a real ambiguity), and every
 * value is proved against its own schema. No field names a rendezvous: the app finds one itself.
 */
export function parseShareFragment(fragment: string): ShareLinkSeed {
  const pieces = (fragment.startsWith('#') ? fragment.slice(1) : fragment).split(';');
  if (pieces.shift() !== 'v1') throw new Error('share link version is not recognised');
  const fields = new Map<string, string>();
  for (const piece of pieces) {
    const separator = piece.indexOf('=');
    if (separator <= 0) throw new Error('share link field is not name=value');
    const name = piece.slice(0, separator);
    if (fields.has(name)) throw new Error(`share link repeats ${name}`);
    let value: string;
    try {
      value = decodeURIComponent(piece.slice(separator + 1));
    } catch {
      throw new Error(`share link field ${name} is not decodable`);
    }
    fields.set(name, value);
  }
  const daemonUrl = fields.get('url');
  const fingerprint = fields.get('fp');
  const code = fields.get('share');
  if (daemonUrl === undefined || fingerprint === undefined || code === undefined)
    throw new Error('share link must include url, fp and share');
  try {
    new URL(daemonUrl);
  } catch {
    throw new Error('share link publisher address is not a URL');
  }
  const daemonId = DaemonIdSchema.safeParse(fingerprint);
  if (!daemonId.success) throw new Error('share link carries an invalid fingerprint');
  const parsedCode = CatalogShareCodeSchema.safeParse(code);
  if (!parsedCode.success) throw new Error('share link carries an invalid code');
  return { daemonUrl, daemonId: daemonId.data, code: parsedCode.data };
}

// ── The member passkey's name ────────────────────────────────────────────────────────────────────

/** WebAuthn recommends user names of at most 64 bytes; a passkey manager may cut a longer one anywhere. */
export const MEMBER_PASSKEY_NAME_MAX = 64;

const shorten = (text: string, max: number): string => {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, Math.max(1, max - 1)).join('')}…`;
};

/**
 * The name a member passkey is registered under (design §3.2): "‹member› · ‹catalog or 'N catalogs'› ·
 * ‹publisher›", e.g. "Alice · Kirin's skills · kirin-box", so a person with five shares can tell their
 * passkeys apart and knows which one to delete when access ends. Each part is shortened so the whole fits
 * {@link MEMBER_PASSKEY_NAME_MAX} characters, the publisher's name kept longest.
 */
export function memberPasskeyName(memberLabel: string, catalogNames: readonly string[], daemonName: string): string {
  const what = catalogNames.length === 1 ? (catalogNames[0] ?? '') : `${catalogNames.length} catalogs`;
  const name = `${memberLabel} · ${what} · ${daemonName}`;
  if (Array.from(name).length <= MEMBER_PASSKEY_NAME_MAX) return name;
  return `${shorten(memberLabel, 16)} · ${shorten(what, 24)} · ${shorten(daemonName, 18)}`;
}
