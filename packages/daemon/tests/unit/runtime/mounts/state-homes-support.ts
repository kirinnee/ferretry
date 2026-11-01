import type { StateHomes } from '@ferretry/fleet';

/**
 * Resolved state homes for a route test, each its own real path, home `n` (from 1) being device 1, inode `n`. The
 * guard's `resolveStateHomes` is the only real maker of these and reads the disk; a route judges by name
 * (`stateHomeByName`) and by the identities its pinned walk recorded, so these numbers are what a test's walk must
 * carry to be "the home" by identity.
 */
export const homesOf = (...homes: readonly string[]): StateHomes => homesPinned(homes, []);

/** The same, with key files pinned by device and inode. */
export const homesPinned = (
  homes: readonly string[],
  pinned: readonly { readonly device: bigint; readonly inode: bigint }[],
): StateHomes =>
  ({
    homes: homes.map((named, index) => ({ named, real: named, device: 1n, inode: BigInt(index + 1) })),
    openings: [],
    pinned,
  }) as unknown as StateHomes;
