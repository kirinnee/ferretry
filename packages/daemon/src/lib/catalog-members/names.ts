/**
 * A member's name is their user ID on this machine (docs/catalogs.md § Members): two members never share one,
 * compared by `memberNameKey`. This file is the pure part of that rule: finding a free name for a person whose name is taken.
 */
import { memberNameKey } from '@ferretry/protocol';

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
 * What the owner reads once after people were renamed. The names are the owner's own text, so they are
 * only ever shown here and never written to the audit log.
 */
export function renameNotice(renames: readonly MemberRename[]): string {
  const tail = 'Each still signs in with their passkeys. Rename or remove whichever is wrong in Sharing › People.';
  const [only] = renames;
  if (renames.length === 1 && only !== undefined)
    return `2 people had the same user ID, so the later one was renamed: ${only.from} → ${only.to}. ${tail}`;
  return `Several people had the same user ID, so the later ones were renamed: ${renames.map(rename => `${rename.from} → ${rename.to}`).join(', ')}. ${tail}`;
}
