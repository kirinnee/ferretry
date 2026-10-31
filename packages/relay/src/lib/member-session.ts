/**
 * MEMBER SESSIONS: the records a catalog member's browser opens a session with (docs/relay-protocol.md
 * §14 "Member sessions", docs/catalogs.md § Members).
 *
 * A member is a person the publisher shared catalogs with, not a paired device. Their browser holds a
 * non-extractable Ed25519 MEMBER key for this publisher and proves it the way a device proves its device
 * key — by signing this session's transcript hash — under labels of its OWN, so a member proof can never
 * be read as a device proof, a pairing proof, or the reverse:
 *
 * ```
 * join   = Ed25519(member key, "ferretry-member-join-v1"  ‖ 0x00 ‖ TH ‖ LP(memberKey) ‖ LP(boxKey))
 * member = Ed25519(member key, "ferretry-member-auth-v1"  ‖ 0x00 ‖ TH ‖ LP("member") ‖ LP(keyId) ‖ LP(appSession))
 * renew  = Ed25519(member key, "ferretry-member-renew-v1" ‖ 0x00 ‖ TH ‖ LP(nonce))
 * ```
 *
 * Each field enters as its base64url TEXT, as every other proof in §6 does. `TH` binds the session, so a
 * captured proof verifies for no other session.
 *
 * TWO RECORDS AT SEQUENCE 1, each committing its session to one job, added to §14's strict union:
 *
 * - `join` — one redemption of a share code, one sealed outcome (`joined` or the generic `join-refused`),
 *   then the session ends with `4440`. Never a path to serving: a browser that joined reconnects with
 *   `member`.
 * - `member` — a request session on the MEMBER route table (`/v1/shared/*`) and nothing else, with the
 *   same lease, renew and close rules a device's request session has.
 *
 * A `guest` record (public catalogs, design §2.8) is reserved for phase 4 and is not part of this union.
 * The publisher's side of every record is 2b's; this module is the shared wire both ends parse with.
 */
import { MemberJoinedResponseSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { concatBytes, fromBase64UrlFixed, isAllZero, lengthPrefixed, utf8Bytes } from './binary.ts';
import { SESSION_PROTOCOL_ID, X25519_PUBLIC_KEY_BYTES } from './constants.ts';
import { AppSessionSchema, DeviceKeySchema, DeviceProofSchema } from './device-proof.ts';

/** One label per act, none shared with a device, a pairing, a handshake or a catalog signature. */
export const MEMBER_JOIN_LABEL = 'ferretry-member-join-v1' as const;
export const MEMBER_AUTH_LABEL = 'ferretry-member-auth-v1' as const;
export const MEMBER_RENEW_LABEL = 'ferretry-member-renew-v1' as const;

/** The `t` a member proof signs, so the label and the record agree on what the session is for. */
export const MEMBER_SESSION_KIND = 'member' as const;

const labelled = (label: string, transcriptHash: Uint8Array, fields: readonly string[]): Uint8Array =>
  concatBytes([
    utf8Bytes(label),
    new Uint8Array([0]),
    transcriptHash,
    ...fields.map(field => lengthPrefixed(utf8Bytes(field))),
  ]);

/** `"ferretry-member-join-v1" ‖ 0x00 ‖ TH ‖ LP(memberKey) ‖ LP(boxKey)`, each key as its base64url text. */
export function memberJoinMessage(transcriptHash: Uint8Array, memberKey: string, boxKey: string): Uint8Array {
  return labelled(MEMBER_JOIN_LABEL, transcriptHash, [memberKey, boxKey]);
}

/** `"ferretry-member-auth-v1" ‖ 0x00 ‖ TH ‖ LP("member") ‖ LP(keyId) ‖ LP(appSession)` */
export function memberAuthMessage(transcriptHash: Uint8Array, keyId: string, appSession: string): Uint8Array {
  return labelled(MEMBER_AUTH_LABEL, transcriptHash, [MEMBER_SESSION_KIND, keyId, appSession]);
}

/** `"ferretry-member-renew-v1" ‖ 0x00 ‖ TH ‖ LP(nonce as its base64url text)` */
export function memberRenewMessage(transcriptHash: Uint8Array, nonce: string): Uint8Array {
  return labelled(MEMBER_RENEW_LABEL, transcriptHash, [nonce]);
}

/** A member key on the wire: an Ed25519 SPKI, base64url — the same shape and checks as a device key. */
export const MemberKeySchema = DeviceKeySchema;
/** One Ed25519 signature by a member key. */
export const MemberProofSchema = DeviceProofSchema;

/**
 * The browser's X25519 BOX key, raw 32 bytes, base64url. Filed at join and used by phase 6 to wrap a
 * members-only artifact's content key to this browser. An all-zero key is a point nothing can agree with.
 */
export const MemberBoxKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, 'expected 32 bytes as base64url')
  .refine(text => {
    const bytes = fromBase64UrlFixed(text, X25519_PUBLIC_KEY_BYTES);
    return bytes !== null && !isAllZero(bytes);
  }, 'not a usable X25519 public key');

const Dialect = z.literal(SESSION_PROTOCOL_ID);

/**
 * `join`: redeem a share code once, registering a member key and proving this session holds it.
 *
 * Bounded only so a hostile record cannot be enormous. What a code, a client name or a key may BE is the
 * share API's to decide (`@ferretry/protocol`'s `catalog-member.ts`), and a field that is merely malformed
 * must be refused exactly like a wrong code — the one generic `join-refused` — never as a parse failure a
 * guesser could tell apart. So this record is deliberately looser than those schemas.
 */
export const MemberJoinRecordSchema = z.strictObject({
  t: z.literal('join'),
  protocol: Dialect,
  code: z.string().min(1).max(64),
  clientName: z.string().min(1).max(256),
  memberKey: z.string().min(1).max(128),
  boxKey: z.string().min(1).max(128),
  proof: z.string().min(1).max(128),
});
export type MemberJoinRecord = z.infer<typeof MemberJoinRecordSchema>;

/** `member`: open a request session on the member route table, proving the member key filed at join. */
export const MemberAuthRecordSchema = z.strictObject({
  t: z.literal('member'),
  protocol: Dialect,
  keyId: z.string().min(1).max(64),
  appSession: AppSessionSchema,
  proof: MemberProofSchema,
});
export type MemberAuthRecord = z.infer<typeof MemberAuthRecordSchema>;

/** The member's answer to a `renew`: the same key, over this session's transcript and the nonce. */
export const MemberRenewedRecordSchema = z.strictObject({
  t: z.literal('renewed'),
  protocol: Dialect,
  proof: MemberProofSchema,
});

/**
 * The publisher's sealed answers to a `join`, then `4440`. ONE refusal for every cause — an unknown,
 * spent or expired code, a full publisher, a malformed field, a proof that did not verify — so a surface
 * the whole internet can reach is no oracle. As with pairing, a publisher with no live share still keys
 * the channel and refuses identically.
 */
export const MemberJoinOutcomeSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('joined'), protocol: Dialect, response: MemberJoinedResponseSchema }),
  z.strictObject({ t: z.literal('join-refused'), protocol: Dialect, reason: z.literal('join_refused') }),
]);
export type MemberJoinOutcome = z.infer<typeof MemberJoinOutcomeSchema>;
