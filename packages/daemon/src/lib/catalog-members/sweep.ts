/**
 * Which browsers of which members are removed because time passed (docs/relay-protocol.md § The passkey
 * window): a key that registered no passkey when its ten-minute window closed could never do anything, and a
 * key nobody used for 90 days is removed like an idle device. The member stays either way.
 *
 * Pure: the timer adapter only calls the service, which calls this with the instant.
 */
import { MEMBER_KEY_IDLE_EXPIRY_DAYS } from '@ferretry/protocol';
import type { MembersDocument, StoredMemberKey } from './document.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RemovedKey {
  readonly memberId: string;
  readonly keyId: string;
  readonly why: 'passkey-window' | 'idle';
}

export interface Swept {
  readonly members: MembersDocument;
  readonly removed: readonly RemovedKey[];
}

function why(key: StoredMemberKey, now: number): RemovedKey['why'] | undefined {
  if (key.passkeyCount === 0 && key.passkeyWindowEndsAt !== undefined && Date.parse(key.passkeyWindowEndsAt) <= now)
    return 'passkey-window';
  const lastUsed = Date.parse(key.lastSeenAt ?? key.joinedAt);
  return lastUsed + MEMBER_KEY_IDLE_EXPIRY_DAYS * DAY_MS <= now ? 'idle' : undefined;
}

/** A key whose passkey window has closed with a passkey in hand no longer shows a window. */
const closed = (key: StoredMemberKey, now: number): StoredMemberKey => {
  if (key.passkeyWindowEndsAt === undefined || Date.parse(key.passkeyWindowEndsAt) > now) return key;
  const { passkeyWindowEndsAt: _ended, ...rest } = key;
  return rest;
};

export function sweepMembers(document: MembersDocument, now: number): Swept {
  const removed: RemovedKey[] = [];
  let changed = false;
  const members = document.members.map(member => {
    const keys: StoredMemberKey[] = [];
    for (const key of member.keys) {
      const reason = why(key, now);
      if (reason !== undefined) {
        removed.push({ memberId: member.memberId, keyId: key.keyId, why: reason });
        changed = true;
        continue;
      }
      const tidy = closed(key, now);
      if (tidy !== key) changed = true;
      keys.push(tidy);
    }
    return keys.length === member.keys.length && keys.every((key, index) => key === member.keys[index])
      ? member
      : { ...member, keys };
  });
  return { members: changed ? { ...document, members } : document, removed };
}

/** True when time has ended this key: the sweep removes it, and until it does nothing may use or revive it. */
export const keyExpired = (key: StoredMemberKey, now: number): boolean => why(key, now) !== undefined;
