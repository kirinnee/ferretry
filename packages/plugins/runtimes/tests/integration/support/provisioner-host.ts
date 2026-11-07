/**
 * The provisioner's host for tests (`daemon/adapters/ports.ts`).
 *
 * GAP(kernel): the provisioner's checked-folder helpers (apply claim, mutation journal, destination folders, source
 * fence, descriptor calls and the guard disk under them) are kernel-owned and a plugin cannot import them, so there is
 * no `ProvisionerKernel` a test can run against yet. Everything that applies a plan through the real helpers
 * therefore sits in a `suite(...)`, which is skipped until {@link KERNEL_HELPERS_AVAILABLE} is true. The suites are
 * ported and type-checked so they run unchanged the day the kernel exports the helpers; none of them has run here.
 */
/* biome-ignore-all lint/suspicious/noExplicitAny: placeholders for kernel-owned classes the tests construct */
import { describe } from 'bun:test';
import { FileFleetProvisioner } from '../../../daemon/adapters/file-provisioner.ts';
import { type ProvisionerHost, refusedProvisionerKernel } from '../../../daemon/adapters/ports.ts';
import { nodeProvisionerDisk } from './node-host.ts';

/** Flip to true once `refusedProvisionerKernel` below is replaced by the kernel's own helpers. */
export const KERNEL_HELPERS_AVAILABLE = false;

/** `describe`, skipped while the kernel helpers are not available. */
export const suite: typeof describe = KERNEL_HELPERS_AVAILABLE ? describe : describe.skip;

export const testHost: ProvisionerHost = { disk: nodeProvisionerDisk, kernel: refusedProvisionerKernel };

/** A provisioner over {@link testHost}; the arguments after `host` are today's. */
type AfterHost<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never;

/** A provisioner over {@link testHost}; the arguments after `host` are today's. */
export const newProvisioner = (...args: AfterHost<ConstructorParameters<typeof FileFleetProvisioner>>): FileFleetProvisioner =>
  new FileFleetProvisioner(testHost, ...args);

const unavailable = (what: string) =>
  class {
    constructor() {
      throw new Error(`${what} is kernel-owned and not available to the Runtimes plugin tests yet`);
    }
  };

// GAP(kernel): stand-ins for the kernel-owned values the destination-fence suites construct.
export const NodeGuardDisk: new (...args: any[]) => any = unavailable('NodeGuardDisk');
export type NodeGuardDisk = any;
export const DestinationFolders: new (...args: any[]) => any = unavailable('DestinationFolders');
export type DestinationFolders = any;
export const FileMutationJournal: new (...args: any[]) => any = unavailable('FileMutationJournal');
export type FileMutationJournal = any;
export const resolveStateHomes = async (..._args: any[]): Promise<any> => {
  throw new Error('resolveStateHomes is kernel-owned and not available to the Runtimes plugin tests yet');
};
export const FILE_OPENINGS: { readonly read: number } = { read: 0 };
export const STAGE_PREFIX: string = refusedProvisionerKernel.stagePrefix;
export const isMutationReservedName = (_name: string): boolean => {
  throw new Error('isMutationReservedName is kernel-owned and not available to the Runtimes plugin tests yet');
};
