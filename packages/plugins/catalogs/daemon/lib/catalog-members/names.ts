/**
 * A member's name is their user ID on this machine (docs/catalogs.md § Members): two members never share one,
 * compared by `memberNameKey`. This file is the pure part of that rule: finding a free name, and the one-time
 * upgrade of a file written before names were IDs.
 */
import { memberNameKey } from '../boundary.ts';

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
