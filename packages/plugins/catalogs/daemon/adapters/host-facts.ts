import type { KernelPorts } from '@ferretry/kernel/contract';
import type { ConnectionsApi } from '@ferretry/plugin-connections/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { CatalogSigningIdentity } from './signatures.ts';

/** TODO(kernel contract): the public identity and fixed-label signer are already on port-kernel. */
export type CatalogKernel = KernelPorts & {
  readonly identity?: { readonly daemonId: string; readonly daemonName: string };
  readonly signer?: CatalogSigningIdentity['signer'];
};
/** TODO(Connections contract): exact additions approved on 0acaa3320 + 8d252446b4. */
export type Advertisement =
  | { readonly kind: 'address'; readonly url: string; readonly origin: 'operator' | 'derived' }
  | { readonly kind: 'local-only'; readonly url: string }
  | { readonly kind: 'none'; readonly refusal: 'loopback-bind' | 'wildcard-bind' | 'no-port' };
export interface ConnectionAdvertisement {
  readonly advertisement: Advertisement;
  readonly discoveredRelayUrl?: string;
  readonly port?: number;
  readonly appOrigin: string;
  readonly allowedOrigins: readonly string[];
  readonly directoryOrigin?: string;
}
type ConnectionFacts = ConnectionsApi & { advertisement?(): ConnectionAdvertisement };
export function connectionFacts(handle: UsesHandle<ConnectionsApi>) {
  return (): ConnectionAdvertisement | undefined => {
    const current = handle.current() as ConnectionFacts | undefined;
    return current?.advertisement?.();
  };
}
