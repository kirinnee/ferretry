import type {
  CatalogMemberCatalogRemoved,
  CatalogMemberKeyRemoved,
  CatalogMemberList,
  CatalogMemberRevoked,
  CatalogMemberView,
  CatalogShareList,
  CatalogShareMintRequest,
  CatalogShareMintResponse,
  CatalogShareView,
  IFyApiClient,
} from '@ferretry/protocol';

/** The owner routes for sharing a catalog (docs/catalogs.md § Members). */
export interface ISharingGateway {
  mint(request: CatalogShareMintRequest): Promise<CatalogShareMintResponse>;
  shares(): Promise<CatalogShareList>;
  endShare(shareId: string): Promise<CatalogShareView>;
  members(): Promise<CatalogMemberList>;
  renameMember(memberId: string, label: string): Promise<CatalogMemberView>;
  revokeMember(memberId: string): Promise<CatalogMemberRevoked>;
  removeKey(memberId: string, keyId: string): Promise<CatalogMemberKeyRemoved>;
  removeCatalog(memberId: string, catalogId: string): Promise<CatalogMemberCatalogRemoved>;
}

/** The only client capability the sharing gateway consumes. */
export type SharingApiClient = Pick<IFyApiClient, 'request'>;

/**
 * Where the share link and its QR are drawn: verbatim, with no colour, for the reason the pairing screen is.
 * A QR is block characters whose only job is contrast.
 */
export interface IShareScreen {
  write(text: string): void;
}
