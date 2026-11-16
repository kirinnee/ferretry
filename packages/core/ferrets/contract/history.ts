import type { RootHandle } from '@ferretry/kernel/contract';

/**
 * WHAT A HARNESS HOLDS OF PAST CONVERSATIONS, as a read-only view (the conversation index's source seam).
 *
 * A harness plugin owns where its CLI keeps transcripts (the owner's `~/.claude`, `~/.codex`, each ferret's own home under
 * its `agent-homes`, later the shared history pool), and Conversation owns what a listing says about them. The seam is the
 * line between the two: the harness hands over {@link HarnessHistorySource}s, each a tree it can already read, and
 * Conversation walks and reads them with these four calls and nothing more. There is no write, remove or link call, so
 * nothing that holds a source can change a transcript, and no path is ever absolute: every path is relative to the tree
 * and `/`-separated, and the harness's own fence decides whether it may be read.
 */

/** What is directly inside one folder of a history tree. A link is `other`: a walk never follows one. */
export interface HarnessHistoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
  /** Bytes, for a file. */
  readonly size: number;
  /** Modification time (ms since the epoch), for a file. */
  readonly modifiedMs: number;
}

export interface HarnessHistoryFiles {
  /** The names inside `directory` (`''` is the tree itself); `[]` when it is absent or cannot be listed. */
  entries(directory: string): Promise<readonly HarnessHistoryEntry[]>;
  /** `undefined` when nothing readable is at `path`. */
  stat(path: string): Promise<{ readonly size: number; readonly modifiedMs: number } | undefined>;
  /** `length` bytes from `offset` (fewer at the end of the file; at most {@link HARNESS_HISTORY_READ_MAX_BYTES}); `undefined` when unreadable. */
  read(path: string, offset: number, length: number): Promise<Uint8Array | undefined>;
}

/** The most one {@link HarnessHistoryFiles.read} returns. */
export const HARNESS_HISTORY_READ_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where a source's transcripts live:
 *   `computer`    the owner's own CLI home (`~/.claude`, `~/.codex`), read in place and never written
 *   `ferret-home` one ferret's own harness home under `agent-homes` (a home whose history is a link into the pool lists
 *                 nothing here: the pool lists it once)
 *   `pool`        the harness's shared history pool
 */
export type HarnessHistoryKind = 'computer' | 'ferret-home' | 'pool';

export interface HarnessHistorySource {
  readonly kind: HarnessHistoryKind;
  /** Names the source within its kind and harness: `owner`, a ferret id, `pool`. */
  readonly label: string;
  /** The CLI home's tree: `projects/…` (Claude) or `sessions/…` and `session_index.jsonl` (Codex) sit directly in it. */
  readonly files: HarnessHistoryFiles;
}

/**
 * {@link HarnessHistoryFiles} over a root the harness plugin holds, read through the root's own fence (links and `..`
 * refused). `within` is a folder of the root the tree starts at (a ferret's id under `agent-homes`). Reads only.
 */
export function historyFilesOver(root: RootHandle, within = ''): HarnessHistoryFiles {
  const place = (relative: string) =>
    root.resolve(within === '' ? relative : relative === '' ? within : `${within}/${relative}`);
  return {
    async entries(directory) {
      const path = place(directory);
      if (!path.ok) return [];
      const listed = await root.entries(path.value).catch(() => []);
      return listed.map(entry => ({
        name: entry.name,
        kind: entry.kind === 'file' || entry.kind === 'directory' ? entry.kind : 'other',
        size: entry.size,
        modifiedMs: Date.parse(entry.modified),
      }));
    },
    async stat(file) {
      const path = place(file);
      const stat = path.ok ? await root.stat(path.value).catch(() => undefined) : undefined;
      return stat === undefined || stat.kind !== 'file'
        ? undefined
        : { size: stat.size, modifiedMs: Date.parse(stat.modified) };
    },
    async read(file, offset, length) {
      const path = place(file);
      if (!path.ok) return undefined;
      return await root
        .readBytes(path.value, { offset, length: Math.min(length, HARNESS_HISTORY_READ_MAX_BYTES) })
        .catch(() => undefined);
    },
  };
}
