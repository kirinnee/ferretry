/**
 * What the member side needs from the machine. Each is a port: the pure code in this folder never reads a
 * file, hashes with a library, or holds a socket (docs/standards/three-layer-architecture).
 */
import type { AuditEntry } from '../audit/types.ts';
import type { MembersDocument, SharesDocument } from './document.ts';

/** `state/catalogs/members.json`. A damaged file is an error from `read`, never an empty document. */
export interface CatalogMembersStore {
  read(): Promise<MembersDocument>;
  write(document: MembersDocument): Promise<void>;
}

/** `state/catalogs/shares.json`. Holds the SHA-256 of each code and never a code. */
export interface CatalogSharesStore {
  read(): Promise<SharesDocument>;
  write(document: SharesDocument): Promise<void>;
}

/**
 * The SHA-256 of a share code's text, as lowercase hex, SYNCHRONOUSLY: the admission step has no
 * suspension point, so it cannot await a digest.
 */
export interface ShareCodeHasher {
  hex(text: string): string;
}

/** The ids of the catalogs this machine publishes, so a share can only name one that exists. */
export interface CatalogDirectory {
  knownIds(): Promise<ReadonlySet<string>>;
}

/**
 * Closes the live sessions of a member or of one browser of a member, AFTER the revoke is written.
 *
 * `LiveMemberSessions` is the one that closes them: every live member session registers there, and a revoke
 * awaits it in the right place.
 */
export interface MemberSessionCloser {
  closeMember(memberId: string): Promise<void>;
  closeKey(memberId: string, keyId: string): Promise<void>;
}

/**
 * Where the owner's share link comes from: the hosted app's origin and the address the link carries (the
 * joining browser dials it first, or the discovered rendezvous first when it is loopback), or why there is none.
 * Asked BEFORE a code is made, so a machine with no address to put in a link never spends one.
 */
export type ShareLinkTarget =
  | { readonly kind: 'ready'; readonly appOrigin: string; readonly daemonUrl: string; readonly daemonId: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface ShareLinkSource {
  target(): ShareLinkTarget;
}

/** Where the domain tells the owner what a member did that the owner should know. */
export interface MemberAuditSink {
  record(entry: AuditEntry): Promise<void>;
}
