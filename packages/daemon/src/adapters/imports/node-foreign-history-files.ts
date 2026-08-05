import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ForeignHistoryEntry, ForeignHistoryFiles, ForeignHistoryRoots } from '../../lib/imports/index.ts';

/** Node implementation of the importer's deliberately read-only filesystem port. */
export class NodeForeignHistoryFiles implements ForeignHistoryFiles {
  async entries(directory: string): Promise<readonly ForeignHistoryEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.map(entry => ({
      name: entry.name,
      // A symlink is intentionally `other`: foreign history discovery never follows it.
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }));
  }

  async text(file: string): Promise<string | undefined> {
    return await Bun.file(file)
      .text()
      .catch(() => undefined);
  }
}

/** The two real harness layouts. Tests inject fixture roots and never name a user's home. */
export function foreignHistoryRoots(home = homedir()): ForeignHistoryRoots {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    codexSessions: join(home, '.codex', 'sessions'),
  };
}
