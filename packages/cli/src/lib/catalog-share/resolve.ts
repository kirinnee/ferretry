import type { CatalogMemberView } from '@ferretry/protocol';
import { pick } from '../catalog/resolve.ts';

/** One member by id, then by exact label, then by label ignoring case; a label two people share is refused with the ids. */
export function resolveMember(members: readonly CatalogMemberView[], wanted: string): CatalogMemberView {
  const found = pick(
    members.map(member => ({ name: member.label, member })),
    entry => entry.member.memberId,
    wanted,
    'person',
  );
  return found.member;
}

/** One of a member's browsers by key id, or by the name it gave itself when exactly one has it. */
export function resolveKey(member: CatalogMemberView, wanted: string): CatalogMemberView['keys'][number] {
  const found = pick(
    member.keys.map(key => ({ name: key.clientName, key })),
    entry => entry.key.keyId,
    wanted,
    `browser of ${member.label}`,
  );
  return found.key;
}
