/**
 * A member's name is their user ID on this machine (docs/catalogs.md § Members): two members never share one,
 * compared by `memberNameKey`. This file is the pure part of that rule: finding a free name, and the one-time
 * upgrade of a file written before names were IDs.
 */
import { memberNameKey } from '@ferretry/protocol';
import type { StoredMember } from './document.ts';

/** The most a stored name may hold (the protocol's label limit). */
const NAME_MAX = 80;

/** One person renamed so their name is free. IDs and the owner's own text: the text never reaches the audit log. */
export interface MemberRename {
  readonly memberId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * `name`, or `name (2)`, `name (3)`, … the first whose key is not in `taken`. The base is cut to leave room for
 * the suffix inside the 80-character limit, and never in the middle of a character.
 */
export function freeMemberName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(memberNameKey(name))) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${String(n)})`;
    const base = Array.from(name);
    while (base.join('').length + suffix.length > NAME_MAX) base.pop();
    const candidate = `${base.join('').trimEnd()}${suffix}`;
    if (!taken.has(memberNameKey(candidate))) return candidate;
  }
}

/**
 * Every member with a name of their own. The OLDEST member keeps the plain name; each later one becomes
 * `name (2)`, `name (3)`, … Nobody is merged and nobody loses a browser, a catalog or a passkey: only the name
 * changes. Answers the same document when no two members shared a name.
 */
export function uniqueMemberNames(members: readonly StoredMember[]): {
  readonly members: readonly StoredMember[];
  readonly renames: readonly MemberRename[];
} {
  // Oldest first decides who keeps the name; the file order breaks a tie, so the result is deterministic.
  const order = members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => Date.parse(a.member.createdAt) - Date.parse(b.member.createdAt) || a.index - b.index);
  const taken = new Set<string>();
  const renamed = new Map<string, string>();
  for (const { member } of order) {
    const name = freeMemberName(member.label, taken);
    taken.add(memberNameKey(name));
    if (name !== member.label) renamed.set(member.memberId, name);
  }
  if (renamed.size === 0) return { members, renames: [] };
  return {
    members: members.map(member => {
      const to = renamed.get(member.memberId);
      return to === undefined ? member : { ...member, label: to };
    }),
    renames: order.flatMap(({ member }) => {
      const to = renamed.get(member.memberId);
      return to === undefined ? [] : [{ memberId: member.memberId, from: member.label, to }];
    }),
  };
}

/**
 * What the owner reads once after an upgrade renamed people. The names are the owner's own text, so they are
 * only ever shown here and never written to the audit log.
 */
export function renameNotice(renames: readonly MemberRename[]): string {
  const fix = 'Rename or remove whichever is wrong in Sharing › People.';
  const [only] = renames;
  if (renames.length === 1 && only !== undefined)
    return `Two people here had the same name, so one is now ${only.to}. ${fix}`;
  return `Several people here had the same name, so ${String(renames.length)} are now ${renames.map(rename => rename.to).join(', ')}. ${fix}`;
}
