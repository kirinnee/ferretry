/**
 * THE ADMISSION STEP: docs/relay-protocol.md §14 "The order of the checks", step 2, as one pure function
 * with no suspension point.
 *
 * It takes the stored documents and the reservations already waiting, and answers a reservation (with the
 * share as it stands once the code is spent) or ONE refusal. It changes nothing itself: the service that
 * calls it swaps the answer in synchronously, so two concurrent joins cannot both spend one code.
 *
 * ## The order, which is contract
 *
 * 1. Find the share by the code's SHA-256, compared in constant time against EVERY stored share and a dummy.
 * 2. It must be live: a code that is unknown, spent, expired or ended is one refusal.
 * 3. Room: the publisher's members and keys, the member's own keys, the member's catalogs. A refusal for
 *    room LEAVES THE CODE LIVE.
 * 4. The share's own hourly count of successful joins and redeems. Also leaves the code live.
 * 5. Burn the code (single use) or count one use (multi use).
 * 6. Reserve the key's slot.
 *
 * A REDEEM runs the same order for the code, then the Q5 rules (owner decision): a single-use code is burned
 * BEFORE it is compared with the redeeming browser's member, so a refusal still leaves it spent and the owner
 * is told; a multi-use code counts a use only when the redeem adds a catalog, and a different member's
 * browser is refused without counting.
 */
import {
  CATALOG_MAX_KEYS_PER_MEMBER,
  CATALOG_MAX_MEMBER_KEYS,
  CATALOG_MAX_MEMBERS,
  CATALOG_SHARE_MAX_CATALOGS,
  type CatalogShareRefusal,
  type CatalogShareState,
  MEMBER_JOINS_PER_HOUR,
} from '@ferretry/protocol';
import type { MembersDocument, SharesDocument, StoredMember, StoredShare } from './document.ts';

export const HOUR_MS = 60 * 60 * 1_000;

/** What compares two hex digests without leaking where they differ. */
export type DigestComparison = (left: string, right: string) => boolean;

/** A hash that no code has, compared against when there is nothing to find so that "none" costs what "some" does. */
const DUMMY_DIGEST = '0'.repeat(64);

/**
 * Why a step was refused, for the owner's log and the tests. The wire says one thing for several of these
 * (a joiner is told only `join-refused`); this is for the people who run the machine.
 */
type AdmissionReason =
  | 'unknown'
  | 'spent'
  | 'expired'
  | 'ended'
  | 'member-gone'
  | 'unknown-member'
  | 'members'
  | 'keys'
  | 'member-keys'
  | 'catalogs'
  | 'hourly'
  | 'other-member'
  | 'new-member';

/** A browser of one member used a code made for another (owner decision Q5): the owner is told. */
export interface CrossMemberUse {
  readonly shareId: string;
  /** The member whose browser used the code. */
  readonly memberId: string;
  /** The member the code was minted for. */
  readonly shareMemberId: string;
}

export interface JoinReservation {
  readonly kind: 'join';
  readonly reservationId: string;
  readonly shareId: string;
  readonly memberId: string;
  readonly memberLabel: string;
  readonly catalogIds: readonly string[];
}

export interface RedeemReservation {
  readonly kind: 'redeem';
  readonly reservationId: string;
  readonly shareId: string;
  readonly memberId: string;
  /** The catalogs the redeem adds, in the share's order. Empty when the member already held them all. */
  readonly added: readonly string[];
}

export type Reservation = JoinReservation | RedeemReservation;

export interface Refused {
  readonly ok: false;
  readonly refusal: CatalogShareRefusal;
  readonly reason: AdmissionReason;
  /** The shares as they stand: unchanged, except that a single-use code a redeem was refused for is spent. */
  readonly shares: SharesDocument;
  /** Whether the code can still be used. A refusal for room or the hourly count leaves it live. */
  readonly leftLive: boolean;
  readonly crossMember?: CrossMemberUse;
}

export interface Admitted<R extends Reservation> {
  readonly ok: true;
  readonly shares: SharesDocument;
  readonly reservation: R;
}

export type JoinAdmission = Admitted<JoinReservation> | Refused;
export type RedeemAdmission = Admitted<RedeemReservation> | Refused;

/** What one admission reads. */
export interface Probe {
  readonly members: MembersDocument;
  readonly shares: SharesDocument;
  /** Joins that passed this step and have not committed or been released yet: they hold slots. */
  readonly pending: readonly JoinReservation[];
  readonly now: number;
  /** The SHA-256 of the code the caller presented, lowercase hex. */
  readonly digest: string;
  readonly compare: DigestComparison;
  readonly reservationId: string;
}

/** A share's state at `now`: a stored `live` whose time has passed reads as `expired`. */
export function shareState(share: StoredShare, now: number): CatalogShareState {
  if (share.state !== 'live') return share.state;
  return Date.parse(share.expiresAt) <= now ? 'expired' : 'live';
}

/**
 * The share whose digest this is, looking at EVERY stored share and the dummy whatever is found, so a
 * publisher with no live share takes the same path as one with many.
 */
export function locateShare(
  shares: SharesDocument,
  digest: string,
  compare: DigestComparison,
): StoredShare | undefined {
  let found: StoredShare | undefined;
  for (const share of shares.shares) if (compare(share.codeSha256, digest)) found = share;
  compare(DUMMY_DIGEST, digest);
  return found;
}

const refused = (
  probe: Probe,
  refusal: CatalogShareRefusal,
  reason: AdmissionReason,
  extra: Partial<Pick<Refused, 'shares' | 'crossMember'>> = {},
): Refused => ({
  ok: false,
  refusal,
  reason,
  shares: extra.shares ?? probe.shares,
  leftLive: extra.shares === undefined,
  ...(extra.crossMember === undefined ? {} : { crossMember: extra.crossMember }),
});

/** The share, or the refusal for a code that is not live. */
function liveShare(probe: Probe): StoredShare | Refused {
  const share = locateShare(probe.shares, probe.digest, probe.compare);
  if (share === undefined) return { ...refused(probe, 'share_refused', 'unknown'), leftLive: false };
  const state = shareState(share, probe.now);
  return state === 'live' ? share : { ...refused(probe, 'share_refused', state), leftLive: false };
}

const recentSuccesses = (share: StoredShare, now: number): readonly number[] =>
  share.successes.filter(at => at > now - HOUR_MS);

const mergedCatalogs = (member: StoredMember | undefined, extra: readonly string[]): number =>
  new Set([...(member?.catalogIds ?? []), ...extra]).size;

/** The room a join needs, or the first thing it would overrun. */
function roomProblem(probe: Probe, share: StoredShare, member: StoredMember | undefined): AdmissionReason | undefined {
  const stored = new Set(probe.members.members.map(entry => entry.memberId));
  const members = new Set(probe.pending.map(entry => entry.memberId).filter(id => !stored.has(id)));
  if (member === undefined) members.add(share.memberId);
  if (stored.size + members.size > CATALOG_MAX_MEMBERS) return 'members';
  const keys = probe.members.members.reduce((sum, entry) => sum + entry.keys.length, 0) + probe.pending.length + 1;
  if (keys > CATALOG_MAX_MEMBER_KEYS) return 'keys';
  const ownKeys =
    (member?.keys.length ?? 0) + probe.pending.filter(entry => entry.memberId === share.memberId).length + 1;
  if (ownKeys > CATALOG_MAX_KEYS_PER_MEMBER) return 'member-keys';
  if (mergedCatalogs(member, share.catalogIds) > CATALOG_SHARE_MAX_CATALOGS) return 'catalogs';
  return undefined;
}

/** The share with one use spent: a single-use code is burned, a multi-use one counts toward its cap. */
function spent(share: StoredShare, now: number, succeeded: boolean): StoredShare {
  const used = share.used + 1;
  const done = share.uses.kind === 'single' || used >= share.uses.cap;
  return {
    ...share,
    used,
    state: done ? 'spent' : 'live',
    successes: succeeded ? [...recentSuccesses(share, now), now].slice(-MEMBER_JOINS_PER_HOUR) : share.successes,
  };
}

const withShare = (shares: SharesDocument, next: StoredShare): SharesDocument => ({
  ...shares,
  shares: shares.shares.map(share => (share.shareId === next.shareId ? next : share)),
});

/** Step 2 of a join: find, live, room, the hourly count, spend the code, reserve the key's slot. */
export function admitJoin(probe: Probe): JoinAdmission {
  const share = liveShare(probe);
  if ('ok' in share) return share;
  const member = probe.members.members.find(entry => entry.memberId === share.memberId);
  // A code made for a member who has since gone cannot make a browser of them: it is refused and left alone,
  // because ending the member ended their shares and this one only survives a failed write.
  if (member === undefined && share.memberKind === 'existing') return refused(probe, 'share_refused', 'member-gone');
  const room = roomProblem(probe, share, member);
  if (room !== undefined) return refused(probe, 'members_full', room);
  if (recentSuccesses(share, probe.now).length >= MEMBER_JOINS_PER_HOUR)
    return refused(probe, 'members_full', 'hourly');
  return {
    ok: true,
    shares: withShare(probe.shares, spent(share, probe.now, true)),
    reservation: {
      kind: 'join',
      reservationId: probe.reservationId,
      shareId: share.shareId,
      memberId: share.memberId,
      memberLabel: member?.label ?? share.memberLabel,
      catalogIds: share.catalogIds,
    },
  };
}

/** Step 2 of a redeem by a browser that already belongs to `memberId` (owner decision Q5). */
export function admitRedeem(probe: Probe, memberId: string): RedeemAdmission {
  const share = liveShare(probe);
  if ('ok' in share) return share;
  const member = probe.members.members.find(entry => entry.memberId === memberId);
  if (member === undefined) return refused(probe, 'member_unknown', 'unknown-member');
  const mismatch = share.memberId !== memberId;
  const mismatchRefusal = share.memberKind === 'new' ? 'share_new_member' : 'share_other_member';
  const mismatchReason = share.memberKind === 'new' ? 'new-member' : 'other-member';
  const added = share.catalogIds.filter(id => !member.catalogIds.includes(id));
  const reservation: RedeemReservation = {
    kind: 'redeem',
    reservationId: probe.reservationId,
    shareId: share.shareId,
    memberId,
    added,
  };

  if (share.uses.kind === 'multi') {
    // A different member's browser is refused WITHOUT counting, and a redeem that adds nothing costs nothing.
    if (mismatch) return { ...refused(probe, mismatchRefusal, mismatchReason), leftLive: true };
    if (added.length === 0) return { ok: true, shares: probe.shares, reservation };
  }
  if (!mismatch && mergedCatalogs(member, share.catalogIds) > CATALOG_SHARE_MAX_CATALOGS)
    return refused(probe, 'members_full', 'catalogs');
  if (recentSuccesses(share, probe.now).length >= MEMBER_JOINS_PER_HOUR)
    return refused(probe, 'members_full', 'hourly');

  if (mismatch) {
    // Single use: BURN FIRST, then compare. Whatever the answer, nobody else can use this code.
    return refused(probe, mismatchRefusal, mismatchReason, {
      shares: withShare(probe.shares, spent(share, probe.now, false)),
      crossMember: { shareId: share.shareId, memberId, shareMemberId: share.memberId },
    });
  }
  return { ok: true, shares: withShare(probe.shares, spent(share, probe.now, true)), reservation };
}
