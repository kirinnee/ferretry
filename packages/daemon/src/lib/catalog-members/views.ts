/**
 * The owner's lists, as the wire shows them. Nothing here has a field for a code, a digest, a member key or a
 * box key: a view is built field by field from the stored record, never by spreading it.
 */
import { CATALOG_SHARES_LISTED_MAX, type CatalogMemberView, type CatalogShareView } from '@ferretry/protocol';
import type { StoredMember, StoredShare } from './document.ts';
import { shareState } from './admission.ts';

export function memberView(member: StoredMember): CatalogMemberView {
  return {
    memberId: member.memberId,
    label: member.label,
    catalogIds: [...member.catalogIds],
    createdAt: member.createdAt,
    keys: member.keys.map(key => ({
      keyId: key.keyId,
      clientName: key.clientName,
      joinedAt: key.joinedAt,
      ...(key.lastSeenAt === undefined ? {} : { lastSeenAt: key.lastSeenAt }),
      passkeys: key.passkeyCount,
      ...(key.passkeyWindowEndsAt === undefined ? {} : { passkeyWindowEndsAt: key.passkeyWindowEndsAt }),
    })),
  };
}

export function shareView(share: StoredShare, now: number): CatalogShareView {
  return {
    shareId: share.shareId,
    memberId: share.memberId,
    memberLabel: share.memberLabel,
    catalogIds: [...share.catalogIds],
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    uses: share.uses,
    state: shareState(share, now),
    usedBy: share.usedBy.map(entry => ({ clientName: entry.clientName, keyId: entry.keyId, at: entry.at })),
  };
}

/** The live shares first, then the most recent of the rest, up to what a list answers. */
export function listedShares(shares: readonly StoredShare[], now: number): readonly CatalogShareView[] {
  const views = shares.map(share => shareView(share, now));
  const newestFirst = (left: CatalogShareView, right: CatalogShareView): number =>
    right.createdAt.localeCompare(left.createdAt);
  const live = views.filter(view => view.state === 'live').sort(newestFirst);
  const rest = views.filter(view => view.state !== 'live').sort(newestFirst);
  return [...live, ...rest].slice(0, CATALOG_SHARES_LISTED_MAX);
}
