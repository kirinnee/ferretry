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
import { isLoopbackLinkAddress } from './address.ts';
import { PublishedCarriersSchema } from './carriers.ts';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema, DaemonNameSchema, isDialableLinkAddress, readLinkFragmentFields } from './pairing.ts';
import { CatalogLabelSchema, HIDDEN_IN_LINE, SharedCatalogIdSchema } from './shared-catalog.ts';

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
export const CATALOG_SHARE_MULTI_CAP_MAX = 200;
/** How many catalogs one share may grant. */
export const CATALOG_SHARE_MAX_CATALOGS = 64;
/** Live (unspent, unexpired) shares at once. */
export const CATALOG_MAX_LIVE_SHARES = 64;

export const CATALOG_MAX_MEMBERS = 128;
/** Browsers across every member. A full publisher refuses a join and LEAVES THE CODE LIVE, as a full pairing does. */
export const CATALOG_MAX_MEMBER_KEYS = 512;
/**
 * Browsers one member may have. Below the publisher-wide bound, so one leaked multi-use code fills at most its
 * own member and never shuts every other invitee out. A key that never registered a passkey is removed when
 * its passkey window closes, so such a flood also drains on its own.
 */
export const CATALOG_MAX_KEYS_PER_MEMBER = 200;

/** After a join, the new key may register its passkey for this long and do nothing else (zero-trust B2). */
export const MEMBER_PASSKEY_WINDOW_SECONDS = 600;
/** One member unlock lasts this many days (owner decision Q4): a member only reads. */
export const MEMBER_UNLOCK_DAYS_DEFAULT = 30;
export const MEMBER_UNLOCK_DAYS_MIN = 1;
export const MEMBER_UNLOCK_DAYS_MAX = 90;
/** A member key nobody used for this long is removed, like an idle device; the member stays. */
export const MEMBER_KEY_IDLE_EXPIRY_DAYS = 90;

/**
 * FAILED joins per minute per peer address, on the direct carrier only. On the relay every attempt is its own
 * rendezvous session, so there is no peer to count by; the rendezvous admission prices them instead.
 */
export const MEMBER_JOIN_ATTEMPTS_PER_MINUTE = 10;
/**
 * SUCCESSFUL joins and redeems per hour per SHARE, whatever the carrier. Only a live code can succeed, so a
 * stranger cannot spend this, and per share so one leaked code never spends another invitee's hour. Checked
 * before the code is burned, so a refusal for it leaves the code live.
 */
export const MEMBER_JOINS_PER_HOUR = 60;
/** How many shares a list answers: the live ones, then the most recent ended ones. */
export const CATALOG_SHARES_LISTED_MAX = 500;

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
 * A share code: `fy_share_` and 22 base64url characters — 16 random bytes, so 128 bits of entropy (the 22
 * characters hold 132 bits; the last 4 are the encoding's zero padding). Far past guessing, so its rate limit
 * only stops floods and no failed attempt ever spends or locks a code. Prefixed so a chat or a code host's
 * secret scanner can recognise a leaked one. It cannot be read as a pairing code, nor a pairing code as it.
 * The publisher stores only the SHA-256 of the code's text, a fingerprint that is safe to keep because a
 * 128-bit value cannot be found from its hash by trying.
 */
export const CatalogShareCodeSchema = z
  .string()
  .regex(/^fy_share_[A-Za-z0-9_-]{22}$/u, 'invalid share code')
  .brand<'CatalogShareCode'>();
export type CatalogShareCode = z.infer<typeof CatalogShareCodeSchema>;

/** What a person is told when a user ID holds a character they cannot see. */
export const MEMBER_NAME_HIDDEN_MESSAGE = "A user ID can't contain hidden characters. Type it again.";

/**
 * A member's name, as the owner wrote it ("Alice", "Workshop Oct 31"): their user ID on this machine. The catalog
 * label's rules, which refuse every hidden, format and control character, because an invisible character would
 * make two look-alike IDs.
 */
export const CatalogMemberLabelSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(text => text.trim() === text, 'no spaces at the start or the end')
  .refine(text => !HIDDEN_IN_LINE.test(text), MEMBER_NAME_HIDDEN_MESSAGE);

/**
 * What makes two names the SAME person: NFKC (so a full-width or ligature look-alike is the same name), trimmed,
 * every run of whitespace collapsed to one space, and case-folded. A name is a member's ID on this machine, so
 * "Alice", "alice", "ＡＬＩＣＥ" and "Alice  " are one person. Pure and total; the stored name keeps the owner's own
 * spelling, only comparison uses this.
 */
export function memberNameKey(name: string): string {
  const folded = name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase().toLowerCase();
  return folded.normalize('NFKC');
}

/** What the joining browser calls itself ("Firefox on a Mac"). Shown to the owner; never trusted. */
export const MemberClientNameSchema = CatalogLabelSchema;

// ── The owner's side (routes on A, `sharing.use`) ────────────────────────────────────────────────

/**
 * Who a share is for. `{ name }` is the person's ID on this machine and the daemon resolves it: a name that
 * is already somebody's (compared by {@link memberNameKey}) reaches that same person, an unknown name makes
 * (and reserves) a new one. The two `kind` arms are what older apps send: `new` is refused with
 * `member_exists` when the name is taken, so it can never make a second person of the same name.
 */
export const CatalogShareMemberSchema = z.union([
  z.strictObject({ name: CatalogMemberLabelSchema }),
  z.strictObject({ kind: z.literal('new'), label: CatalogMemberLabelSchema }),
  z.strictObject({ kind: z.literal('existing'), memberId: CatalogMemberIdSchema }),
]);
export type CatalogShareMember = z.infer<typeof CatalogShareMemberSchema>;

/**
 * Single use: the code burns on its first redemption. Multi use: it ends at its expiry, at its cap, or
 * when the owner ends it, and every browser joins the ONE member the share names (owner decision Q3) — a
 * new person or one who is already in.
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
export const CatalogShareMintRequestSchema = z.strictObject({
  catalogIds: distinctCatalogs,
  member: CatalogShareMemberSchema,
  expiresIn: CatalogShareExpirySchema,
  uses: CatalogShareUsesSchema,
});
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

export const CatalogShareListSchema = z.strictObject({
  shares: z.array(CatalogShareViewSchema).max(CATALOG_SHARES_LISTED_MAX),
});
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
  /** Only for `GET /v1/catalog-members?name=…`: the id of the person that name already is, so a share sheet can say so. */
  match: CatalogMemberIdSchema.optional(),
});
export type CatalogMemberList = z.infer<typeof CatalogMemberListSchema>;

/** `PATCH /v1/catalog-members/:memberId`: the owner's name for a person. */
export const CatalogMemberRenameRequestSchema = z.strictObject({ label: CatalogMemberLabelSchema });
export type CatalogMemberRenameRequest = z.infer<typeof CatalogMemberRenameRequestSchema>;

/** `DELETE /v1/catalog-members/:memberId`: a person removed, with their browsers, and the shares that named them ended. */
export const CatalogMemberRevokedSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  keysRemoved: z.number().int().min(0).max(CATALOG_MAX_KEYS_PER_MEMBER),
  sharesEnded: z.number().int().min(0).max(CATALOG_SHARES_LISTED_MAX),
});
export type CatalogMemberRevoked = z.infer<typeof CatalogMemberRevokedSchema>;

/** `DELETE /v1/catalog-members/:memberId/keys/:keyId`: one browser of a person removed. */
export const CatalogMemberKeyRemovedSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  keyId: CatalogMemberKeyIdSchema,
});
export type CatalogMemberKeyRemoved = z.infer<typeof CatalogMemberKeyRemovedSchema>;

/** `DELETE /v1/catalog-members/:memberId/catalogs/:catalogId`: one catalog taken away from a person. */
export const CatalogMemberCatalogRemovedSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  catalogId: SharedCatalogIdSchema,
});
export type CatalogMemberCatalogRemoved = z.infer<typeof CatalogMemberCatalogRemovedSchema>;

// ── The joining browser ──────────────────────────────────────────────────────────────────────────

/**
 * What a browser is told the one moment its join succeeded, inside the sealed `joined` record. Like the
 * pairing response it has no field for a key, a proof or a fingerprint, and it is embedded WHOLE so the
 * next field added here crosses a relay the day it ships.
 *
 * IT NAMES NO CATALOG, only how many. Both join outcomes are padded to one size (`@ferretry/relay`'s
 * `MEMBER_JOIN_OUTCOME_BYTES`) so a relay operator cannot read the outcome from the record's length, and a
 * list of names is what would make a `joined` too large to pad cheaply. The browser reads the names from
 * `GET /v1/shared/me` once it has a passkey, and the publisher names the passkey itself.
 */
export const MemberJoinedResponseSchema = z.strictObject({
  memberId: CatalogMemberIdSchema,
  keyId: CatalogMemberKeyIdSchema,
  label: CatalogMemberLabelSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
  /** How many catalogs this member may read now. Their names come from `GET /v1/shared/me`. */
  catalogCount: z.number().int().min(0).max(CATALOG_SHARE_MAX_CATALOGS),
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
  /**
   * When this browser's member unlock ends. There is no "unlocked" flag: this route is reachable ONLY from an
   * unlocked session, and a key-only holder must never read the label or the catalogs.
   */
  unlockExpiresAt: InstantSchema,
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
 * - `member_exists`: a name is somebody's already (a person is their name on this machine). The refusal carries
 *   that person's `memberId`; a mint by `{ name }` never raises it, it reaches that person instead.
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
  'member_exists',
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

/**
 * A share fragment, for surfaces that gate before parsing: `v1` with a `share=` field. A pairing fragment
 * (`PAIRING_FRAGMENT_PATTERN`, any `v1`) also admits a share fragment, so a surface ROUTES BY PATH — `/join`
 * is a share, the pairing page a pairing — and only then gates and parses.
 */
export const SHARE_FRAGMENT_PATTERN = /^#?v1;(?:[^;]*;)*share=/u;

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
 * Reads a share fragment back, or throws the reason it cannot. The SAME field reader as a pairing link
 * (`readLinkFragmentFields`): an unrecognised field is ignored, a repeated one refused. One name is refused
 * rather than ignored — `code`, which only a pairing link carries — so a link holding both a pairing code
 * and a share code is read by neither. The publisher's address must be http(s). No field names a
 * rendezvous: the app finds one itself.
 */
export function parseShareFragment(fragment: string): ShareLinkSeed {
  const fields = readLinkFragmentFields(fragment, 'share link');
  if (fields.has('code')) throw new Error('this is a pairing link, not a share link');
  const daemonUrl = fields.get('url');
  const fingerprint = fields.get('fp');
  const code = fields.get('share');
  if (daemonUrl === undefined || fingerprint === undefined || code === undefined)
    throw new Error('share link must include url, fp and share');
  if (!isDialableLinkAddress(daemonUrl)) throw new Error('share link publisher address is not an http or https URL');
  const daemonId = DaemonIdSchema.safeParse(fingerprint);
  if (!daemonId.success) throw new Error('share link carries an invalid fingerprint');
  const parsedCode = CatalogShareCodeSchema.safeParse(code);
  if (!parsedCode.success) throw new Error('share link carries an invalid code');
  return { daemonUrl, daemonId: daemonId.data, code: parsedCode.data };
}

/** Said beside a share link that only a rendezvous carries: who is on the path, and what they can and cannot see. */
export const SHARE_LINK_RELAYED_NOTICE =
  'A person opening this link reaches this machine through the relay it is connected to. The relay sees this machine’s fingerprint, the person’s IP address, when they connect and how much is sent, and can tell whether they joined; never the code, their keys, their name or the catalogs.';

/**
 * WHAT THE OWNER IS TOLD BESIDE A SHARE LINK, composed once for the share sheet and `fy catalog share`, as
 * `localOnlyNotice` is for a pairing link. A daemon mints a loopback-address share link only when it dials a
 * rendezvous another browser can discover (docs/catalogs.md), so a loopback link IS a relayed link and the
 * disclosure belongs beside it. A direct link, or one that does not read, gets nothing.
 */
export function shareLinkNotice(link: string): string | undefined {
  try {
    return isLoopbackLinkAddress(parseShareFragment(new URL(link).hash).daemonUrl)
      ? SHARE_LINK_RELAYED_NOTICE
      : undefined;
  } catch {
    return undefined;
  }
}

// ── The member passkey's name ────────────────────────────────────────────────────────────────────

/**
 * WebAuthn lets an authenticator cut `user.name` at 64 BYTES, anywhere, so the name is built to fit 64 bytes
 * of UTF-8 itself and is never cut by somebody else.
 */
export const MEMBER_PASSKEY_NAME_MAX_BYTES = 64;

const SEPARATOR = ' · ';
const ELLIPSIS = '…';
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** `text` cut to at most `max` UTF-8 bytes, at a character boundary, with an ellipsis when it was cut. */
const shortenToBytes = (text: string, max: number): string => {
  if (bytesOf(text) <= max) return text;
  let kept = '';
  for (const character of text) {
    if (bytesOf(kept + character) + bytesOf(ELLIPSIS) > max) break;
    kept += character;
  }
  return kept + ELLIPSIS;
};

/**
 * The name a member passkey is registered under (design §3.2): "‹member› · ‹catalog or 'N catalogs'› ·
 * ‹publisher›", e.g. "Alice · Kirin's skills · kirin-box", so a person with five shares can tell their
 * passkeys apart and knows which one to delete when access ends. It fits {@link MEMBER_PASSKEY_NAME_MAX_BYTES}:
 * when it would not, each part is shortened to its own byte budget, the publisher's name kept longest
 * because it is what tells two publishers' passkeys apart.
 *
 * It is the publisher's own text and proves nothing: a hostile publisher may call itself "kirin-box" too.
 * The passkey's `user.id` is the member KEY id, not the member id, so a synced passkey manager — which
 * replaces a passkey with the same RP and `user.id` — never lets a member's second browser overwrite the
 * first browser's passkey.
 */
export function memberPasskeyName(memberLabel: string, catalogNames: readonly string[], daemonName: string): string {
  const what = catalogNames.length === 1 ? (catalogNames[0] ?? '') : `${catalogNames.length} catalogs`;
  const name = [memberLabel, what, daemonName].join(SEPARATOR);
  if (bytesOf(name) <= MEMBER_PASSKEY_NAME_MAX_BYTES) return name;
  // The member gets at most 14 bytes and the catalog 18; the publisher gets everything left (at least 24).
  const label = shortenToBytes(memberLabel, 14);
  const catalog = shortenToBytes(what, 18);
  const left = MEMBER_PASSKEY_NAME_MAX_BYTES - bytesOf(label) - bytesOf(catalog) - 2 * bytesOf(SEPARATOR);
  return [label, catalog, shortenToBytes(daemonName, left)].join(SEPARATOR);
}
