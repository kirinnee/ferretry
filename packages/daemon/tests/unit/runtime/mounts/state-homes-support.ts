import type { StateHomes } from '@ferretry/fleet';

/**
 * Resolved state homes for a route test, each its own real path. The guard's `resolveStateHomes` is the only
 * real maker of these and reads the disk; a route judges by name alone (`stateHomeByName`), so the device and
 * inode here are never compared.
 */
export const homesOf = (...homes: readonly string[]): StateHomes =>
  ({
    homes: homes.map((named, index) => ({ named, real: named, device: 1n, inode: BigInt(index + 1) })),
    openings: [],
  }) as unknown as StateHomes;
