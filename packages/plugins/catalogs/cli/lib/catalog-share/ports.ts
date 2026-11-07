import type { PluginClient } from '@ferretry/kernel/manifest';
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
} from '../../../contract/wire/index.ts';

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
export type SharingApiClient = Pick<PluginClient, 'call'>;

/**
 * Where the share link and its QR are drawn: verbatim, with no colour, for the reason the pairing screen is.
 * A QR is block characters whose only job is contrast.
 */
export interface IShareScreen {
  write(text: string): void;
}

/**
 * Draws a link as a QR made of block characters (today's `pair/ports.ts`). Separate from the output port because a
 * QR is drawn verbatim: a tinted QR may not decode.
 */
export interface IQrEncoder {
  encode(value: string, size: 'compact' | 'large'): Promise<string>;
}

/** How wide the terminal is, or nothing when it will not say — a pipe never does. */
export interface ITerminalSize {
  columns(): number | undefined;
}
