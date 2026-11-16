import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessHistoryEntry, HarnessHistoryFiles } from '@ferretry/core-ferrets/contract';

/**
 * A `HarnessHistoryFiles` over a real folder, the way a harness plugin offers one over its root: reads only, a link is
 * `other` and never followed. It has no write of any kind, which is the seam's whole point.
 */
export function diskHistory(root: string): HarnessHistoryFiles {
  return {
    async entries(directory): Promise<readonly HarnessHistoryEntry[]> {
      const names = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
      const out: HarnessHistoryEntry[] = [];
      for (const entry of names) {
        const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
        const info = kind === 'file' ? await stat(join(root, directory, entry.name)).catch(() => undefined) : undefined;
        out.push({ name: entry.name, kind, size: info?.size ?? 0, modifiedMs: info?.mtimeMs ?? 0 });
      }
      return out;
    },
    async stat(path) {
      const info = await stat(join(root, path)).catch(() => undefined);
      return info === undefined || !info.isFile() ? undefined : { size: info.size, modifiedMs: info.mtimeMs };
    },
    async read(path, offset, length) {
      const handle = await open(join(root, path), 'r').catch(() => undefined);
      if (handle === undefined) return undefined;
      try {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
