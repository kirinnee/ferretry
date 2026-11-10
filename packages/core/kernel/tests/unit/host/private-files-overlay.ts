import type { FileIdentity, HostFs } from '../../../host/adapters/node-fs.ts';

/**
 * How far a file's device is from its folder's on a disk that gives them different ones. An overlay filesystem answers a
 * folder with the overlay's own device and a file with the layer's, and a bind mount of a file keeps the FILE's device;
 * a test that wants that disk on any machine says so with {@link overlayDisk} instead of hoping its runner has one.
 */
const OVERLAY_FILE_STEP = 7n;

const shifted = (identity: FileIdentity): FileIdentity =>
  identity.kind === 'file' ? { ...identity, device: identity.device + OVERLAY_FILE_STEP } : identity;

/** `base`, as a disk where every file answers with a device of its own and every folder with its folder's. */
export function overlayDisk(base: HostFs): HostFs {
  return {
    ...base,
    identity: async path => {
      const found = await base.identity(path);
      return found === undefined ? undefined : shifted(found);
    },
    openRead: async path => {
      const opened = await base.openRead(path);
      return { ...opened, identity: shifted(opened.identity) };
    },
  };
}
