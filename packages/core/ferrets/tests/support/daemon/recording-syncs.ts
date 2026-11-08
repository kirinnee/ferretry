import { realpath } from 'node:fs/promises';
import type { HostFs } from '@ferretry/kernel/host';

/**
 * The directory-sync observer for `diskRoot`: wraps the kernel's real adapter (never replaces it, so a case still
 * performs the real IO) and records, IN ORDER, the real path of each folder whose entries were synced. A folder
 * reached through its proven descriptor is named by what that descriptor resolves to. `after` runs once each sync has
 * finished, which is the scheduling point a case uses to enter the window between a publish and its folder sync.
 */
export function recordingSyncs(synced: string[], after?: (path: string) => Promise<void>): (disk: HostFs) => HostFs {
  return disk => ({
    ...disk,
    openDirectory: async path => {
      const opened = await disk.openDirectory(path);
      return {
        ...opened,
        sync: async () => {
          const named = await realpath(opened.entryPath('') ?? path);
          synced.push(named);
          await opened.sync();
          await after?.(named);
        },
      };
    },
  });
}
