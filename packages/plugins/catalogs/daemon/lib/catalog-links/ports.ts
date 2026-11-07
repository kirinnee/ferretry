/**
 * What the link side needs from the machine. Each is a port: the pure code in this folder never reads a file,
 * holds a socket or opens a key (docs/standards/three-layer-architecture).
 */
import type { CatalogItemSource, CatalogLinkKind } from '../boundary.ts';
import type { AuditEntry } from '../audit.ts';
import type { LinkStatus, LinkStoreRefusalCode } from '../relay-wire/index.ts';
import type { LinkSubject } from '../shared-catalogs/service.ts';
import type { LinksDocument } from './document.ts';

/** `state/catalogs/links.json`. A damaged file is an error from `read`, never an empty document. */
export interface LinkDocumentStore {
  read(): Promise<LinksDocument>;
  write(document: LinksDocument): Promise<void>;
}

/**
 * Where a public link's key is kept, sealed, so the owner can Copy the link again. It is the only place a link key
 * is ever written, and a one-time link's key is not written at all.
 */
export interface LinkKeyVault {
  put(linkId: string, key: string): Promise<void>;
  /** The key, or `undefined` when none is kept for this link. A damaged vault is an error, not `undefined`. */
  open(linkId: string): Promise<string | undefined>;
  forget(linkId: string): Promise<void>;
}

/** The store the next link goes to, or why there is none. `selfHosted` links carry the store's address. */
export type LinkStoreSite =
  | { readonly kind: 'ready'; readonly origin: string; readonly selfHosted: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface LinkStoreLocator {
  locate(): Promise<LinkStoreSite>;
}

/** What a store call came to. `unreachable` means the answer is unknown; `refused` means the store said no. */
export type StoreAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'unreachable' }
  | { readonly ok: false; readonly reason: 'refused'; readonly code: LinkStoreRefusalCode };

export interface LinkUpload {
  readonly bundleId: string;
  readonly action: 'create' | 'replace';
  readonly kind: CatalogLinkKind;
  readonly sequence: number;
  readonly expectSequence?: number;
  readonly notAfter: string;
  readonly expiresAt?: string;
  readonly installCap?: number;
  readonly fetchVerifier: string;
  readonly envelope: Uint8Array;
}

/** The signed calls to one store. Every call names the origin the link was uploaded to. */
export interface LinkStoreClient {
  upload(origin: string, upload: LinkUpload): Promise<StoreAnswer<void>>;
  remove(origin: string, bundleId: string): Promise<StoreAnswer<void>>;
  status(origin: string, bundleIds: readonly string[]): Promise<StoreAnswer<LinkStatus>>;
  /** Whether the store at `origin` is taking new links, from its public advertisement. */
  available(origin: string): Promise<boolean>;
}

/** Where the links side tells the owner what it did on its own (a link put back after the store let it lapse). */
export interface LinkAuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** The kept items a link can carry. `SharedCatalogService` is one. */
export interface LinkItems {
  linkSubject(
    selection: { readonly itemId: string; readonly version: number } | { readonly source: CatalogItemSource },
    summary?: string,
  ): Promise<LinkSubject>;
  holdsLinkVersion(itemId: string, version: number): Promise<boolean>;
}
