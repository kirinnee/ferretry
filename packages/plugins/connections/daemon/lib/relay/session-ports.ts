import type { CarrierKey, CarrierLink, CarrierPeer, SessionLayer } from '@ferretry/kernel/contract';
import type { ClaimContext, RendezvousClaim } from '../wire-mirror/index.ts';

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
/** TODO(kernel contract): the kernel owns the identity key and signs the exact copied claim transcript. */
export interface RendezvousSigner {
  readonly daemonId: string;
  signClaim(context: ClaimContext): Promise<RendezvousClaim>;
}
/** TODO(kernel contract): the kernel calls proved only after a device/member proof is verified. */
export type OpenCarrierSession = (
  layer: SessionLayer,
  carrier: CarrierKey,
  peer: CarrierPeer,
  proved: () => void,
) => CarrierLink;
