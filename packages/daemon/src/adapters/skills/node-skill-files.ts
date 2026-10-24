import { open, readdir, readlink, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { SkillDirectoryEntry, SkillFilesPort } from '../../lib/skills/inventory.ts';

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Skill folders and SKILL.md reads on the real file system. */
export class NodeSkillFiles implements SkillFilesPort {
  async list(directory: string, confinedTo: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    const boundary = await realpath(confinedTo).catch(() => undefined);
    if (boundary === undefined) return [];
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const found: SkillDirectoryEntry[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.length > limit) break;
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const folder = join(directory, entry.name);
      const target = await realpath(folder).catch(() => undefined);
      if (target === undefined || !inside(boundary, target)) continue;
      const manifest = join(folder, 'SKILL.md');
      const text = await realpath(manifest).catch(() => undefined);
      if (text === undefined || !inside(boundary, text)) continue;
      const linked = entry.isSymbolicLink() ? await readlink(folder).catch(() => undefined) : undefined;
      found.push({ manifest, ...(linked === undefined ? {} : { linkTarget: resolve(directory, linked) }) });
    }
    return found;
  }

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    const handle = await open(path, 'r').catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      return bytesRead > maxBytes ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
}
