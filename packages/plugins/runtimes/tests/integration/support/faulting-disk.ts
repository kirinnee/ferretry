/**
 * The real fleet disk with one call made to fail (or the world changed first): `hook` runs ahead of every call, with its
 * name and arguments, and may throw to stand in for a disk that refused it, or touch the folder to stand in for a second
 * writer. The call itself is then made on the real disk.
 */
import type { FleetDisk } from '../../../daemon/adapters/fleet-disk.ts';

/** The disk's calls that answer at once (not a promise): the hook never stands between a caller and these. */
const SYNCHRONOUS_CALLS: ReadonlySet<string> = new Set(['contains', 'fenced', 'isSource', 'assertServed']);

export function faultingDisk(
  disk: FleetDisk,
  hook: (call: string, args: readonly unknown[]) => Promise<void>,
): FleetDisk {
  return new Proxy(disk, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      if (SYNCHRONOUS_CALLS.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        await hook(property, args);
        return await value.apply(target, args);
      };
    },
  });
}
