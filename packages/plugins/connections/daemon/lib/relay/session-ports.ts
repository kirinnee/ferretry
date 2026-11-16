import type { CarrierKey, CarrierLink, CarrierPeer, SessionLayer, IdentitySigner } from '@ferretry/kernel/contract';

export interface RelayLinkTimer {
  cancel(): void;
}
export interface RelayLinkScheduler {
  after(milliseconds: number, action: () => void): RelayLinkTimer;
}
export interface RelayLinkSocket {
  send(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}
/** The Kernel owns the identity key and the fixed-label claim transcript. */
export interface RendezvousSigner {
  readonly daemonId: string;
  sign: IdentitySigner['sign'];
}
/** The kernel calls proved only after a device/member proof is verified. */
export type OpenCarrierSession = (
  layer: SessionLayer,
  carrier: CarrierKey,
  peer: CarrierPeer,
  proved: () => void,
) => CarrierLink;
