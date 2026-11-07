import type { KernelPorts } from '@ferretry/kernel/contract';
import {
  HOSTED_APP_ORIGIN,
  HOSTED_RELAY_DIRECTORY_ORIGIN,
  type ConnectionAdvertisement,
  type ConnectionsApi,
} from '@ferretry/plugin-connections/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { CatalogSigningIdentity } from './signatures.ts';

/** The kernel's public identity, plus the link-store request signer the kernel has not published yet. */
export type CatalogKernel = KernelPorts & {
  readonly signer: KernelPorts['signer'] & Partial<Pick<CatalogSigningIdentity['signer'], 'signLinkStoreRequest'>>;
};

/** What Connections says about this machine's reach right now; `undefined` when Connections is off. */
export function connectionFacts(handle: UsesHandle<ConnectionsApi>) {
  return (): ConnectionAdvertisement | undefined => handle.current()?.advertisement();
}

/** The hosted app is where every catalog and share link points and the only origin a member ceremony may run on. */
export const APP_ORIGIN = HOSTED_APP_ORIGIN;
export const ALLOWED_ORIGINS: readonly string[] = [HOSTED_APP_ORIGIN];
/** The shared directory a link store is discovered from when the owner names none. */
export const DIRECTORY_ORIGIN = HOSTED_RELAY_DIRECTORY_ORIGIN;
