import { createHash } from 'node:crypto';
import type {
  HarnessTranscriptBytes,
  HarnessTranscriptStamp,
  HarnessTranscriptTail,
  TranscriptEntry,
  TranscriptReader,
} from '@ferretry/core-ferrets/contract';
import { openTranscriptBytes } from '@ferretry/core-ferrets/contract';
import { MAX_ROOT_WINDOW_BYTES } from '@ferretry/kernel/contract';
import type { FencedPath, FerretId, RootHandle, RootStat } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import { HOME_FILES } from '../../lib/harness/launch.ts';
import { parseEntries } from '../../lib/harness/transcript.ts';
import {
  advanceCursor,
  advanceFrom,
  canAdvance,
  openCursor,
  type TailCursor,
  windowRecords,
} from '../../lib/harness/transcript-cursor.ts';
import { type ClaudeCore, claudeHome, FIRST_RECORDS_BYTES, type Serves } from './core.ts';

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** How much of the end of a transcript one tail read takes: a turn's records are near the end. */
const TAIL_READ_BYTES = 512 * 1024;
/** How many ferrets' tail cursors are kept (each holds at most one window's records). */
const MAX_CURSORS = 256;

/** The exact transcript of the assigned id in its encoded cwd, including after a daemon restart; never one found by guessing. */
async function transcriptFile(
  core: ClaudeCore,
  ferret: FerretId,
): Promise<{ readonly home: RootHandle; readonly file: FencedPath; readonly stat: RootStat } | undefined> {
  const home = claudeHome(core, ferret);
  const binding = home.resolve(HOME_FILES.conversation);
  if (!binding.ok) return undefined;
  let identity: unknown;
  try {
    identity = JSON.parse(await home.readText(binding.value, FIRST_RECORDS_BYTES));
  } catch {
    return undefined;
  }
  if (typeof identity !== 'object' || identity === null) return undefined;
  const { format, id, cwd } = identity as { format?: unknown; id?: unknown; cwd?: unknown };
  if (format !== 1 || !isConversationId(id) || typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
  // `projects` is a link to the shared pool in a pooled home: the root never follows a link out, so the transcript is
  // read through the pool's own handle at the same relative path.
  const projects = home.resolve('projects');
  const pooled = projects.ok && (await home.lstat(projects.value))?.kind === 'symlink';
  const root = pooled ? core.deps.roots.historyPool() : home;
  const file = root.resolve(claudeTranscriptPath(cwd, id));
  if (!file.ok) return undefined;
  const stat = await root.stat(file.value);
  if (stat?.kind !== 'file') return undefined;
  return { home: root, file: file.value, stat };
}

/** Read only the assigned id in its encoded cwd, including after a daemon restart. */
export async function transcriptText(core: ClaudeCore, ferret: FerretId): Promise<string | undefined> {
  const found = await transcriptFile(core, ferret);
  return found === undefined ? undefined : await found.home.readText(found.file, MAX_TRANSCRIPT_BYTES);
}

/**
 * The NEWEST part of the transcript, up to `MAX_TRANSCRIPT_BYTES`, as entries already masked. A long conversation's
 * newest turns are the ones that matter (a delivered send, the turn in progress), so a file larger than the window is
 * read from its END, never its start. The window's first line is dropped unless the byte before it ends a record (it is
 * the end of a record whose start is outside the window); `cut` says the window does not start the file.
 */
async function window(
  core: ClaudeCore,
  ferret: FerretId,
): Promise<{ readonly entries: readonly TranscriptEntry[]; readonly cut: boolean }> {
  const found = await transcriptFile(core, ferret);
  if (found === undefined) return { entries: [], cut: false };
  const start = Math.max(0, found.stat.size - MAX_TRANSCRIPT_BYTES);
  const cut = start > 0;
  // One byte BEFORE a cut window tells whether it begins on a record boundary.
  const from = cut ? start - 1 : 0;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (from + total < found.stat.size) {
    const length = Math.min(MAX_ROOT_WINDOW_BYTES, found.stat.size - from - total);
    const chunk = await found.home.readBytes(found.file, { offset: from + total, length });
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  let keep = 0;
  if (cut) {
    const newline = bytes.indexOf(0x0a);
    // No newline at all: the window is the middle of one record, and nothing in it is complete.
    keep = newline < 0 ? bytes.length : bytes[0] === 0x0a ? 1 : newline + 1;
  }
  // The same record gets the same id in a whole read and in a cut one: an id that has none of its own is its byte offset
  // IN THE FILE (`from + keep` is where these bytes begin in it), not a place within whatever window was read.
  const entries = await core.deps.redaction.read(scope =>
    parseEntries(bytes.subarray(keep), from + keep).map(entry =>
      entry.text === undefined ? entry : { ...entry, text: scope.text(entry.text) },
    ),
  );
  return { entries, cut };
}

/** Entries, already masked when they leave the reader. */
async function entries(core: ClaudeCore, ferret: FerretId): Promise<readonly TranscriptEntry[]> {
  return (await window(core, ferret)).entries;
}

// The 1 s poll on the injected clock IS the chosen design for following a transcript (britnee ruling, 2026-11-16);
// it is not a stand-in for a directory watch.
async function* follow(core: ClaudeCore, ferret: FerretId, signal: AbortSignal): AsyncIterable<TranscriptEntry> {
  const seen = new Set<string>();
  while (!signal.aborted) {
    for (const entry of await entries(core, ferret)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      yield entry;
    }
    await core.deps.clock.sleep(milliseconds(1_000), signal).catch(() => undefined);
  }
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const transcriptPart = (
  core: ClaudeCore,
): Serves<'transcript' | 'transcriptBytes' | 'transcriptStamp' | 'transcriptTail'> => {
  /** One cursor per ferret, the newest looks only (a ferret that is gone is dropped when its transcript no longer resolves). */
  const cursors = new Map<FerretId, TailCursor>();
  const remember = (ferret: FerretId, cursor: TailCursor): void => {
    cursors.delete(ferret);
    cursors.set(ferret, cursor);
    for (const oldest of cursors.keys()) {
      if (cursors.size <= MAX_CURSORS) break;
      cursors.delete(oldest);
    }
  };
  const transcript: TranscriptReader = {
    read: async (ferret, after, limit) => {
      const all = await entries(core, ferret);
      const from = after === undefined ? 0 : all.findIndex(entry => entry.id === after) + 1;
      // An `after` this transcript no longer holds (compaction rewrote it, or it is older than the window) is a cursor
      // that is gone: nothing new, never the whole conversation again (the Codex reader answers the same).
      if (after !== undefined && from === 0) return [];
      return all.slice(from, limit === undefined ? undefined : from + limit);
    },
    readCovering: async (ferret, since) => {
      const read = await window(core, ferret);
      const first = read.entries[0];
      return {
        entries: read.entries,
        covered: !read.cut || (first !== undefined && Date.parse(first.at) <= Date.parse(since)),
      };
    },
    follow: (ferret, signal) => follow(core, ferret, signal),
    find: async (ferret, entry) => (await entries(core, ferret)).find(candidate => candidate.id === entry),
  };

  return {
    transcript,

    /** One stat of the transcript this ferret's assigned conversation wrote (`Harness.transcriptStamp`). */
    async transcriptStamp(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined> {
      const found = await transcriptFile(core, ferret);
      if (found === undefined) return undefined;
      return { file: found.file, size: found.stat.size, mtimeMs: Date.parse(found.stat.modified) };
    },

    /**
     * The assigned conversation's transcript as a windowed, UNMASKED byte handle (`Harness.transcriptBytes`, G162): the
     * file `transcriptFile` proved, read in windows and re-checked for replacement on every read, with an opaque token and
     * no path. Its one consumer (Conversation's reader) masks every answer it cuts from these bytes.
     */
    async transcriptBytes(ferret: FerretId): Promise<HarnessTranscriptBytes | undefined> {
      try {
        const found = await transcriptFile(core, ferret);
        return found === undefined
          ? undefined
          : await openTranscriptBytes(found.home, found.file, 'claude', sha256Hex, { clock: core.deps.clock });
      } catch {
        // A transcript the root refuses (a link put where the file was, a fence it cannot pass) is no proved transcript:
        // none is offered, and the root's refusal is not passed on.
        return undefined;
      }
    },

    /**
     * The newest `limit` records of that transcript, without their text (`Harness.transcriptTail`). A transcript that
     * only grew since the last look is read from where that look ended (only the new bytes are read and parsed); a first
     * look, a smaller file or another file reads the last window whole. The answer is the same either way.
     */
    async transcriptTail(ferret: FerretId, limit: number): Promise<HarnessTranscriptTail> {
      const found = await transcriptFile(core, ferret);
      if (found === undefined) {
        cursors.delete(ferret);
        return { kind: 'unresolved' };
      }
      const identity = await found.home
        .fileIdentity(found.file)
        .then(named => (named === undefined ? undefined : `${named.device}:${named.inode}`))
        .catch(() => undefined);
      const kept = cursors.get(ferret);
      let cursor: TailCursor | undefined;
      if (kept !== undefined && identity !== undefined && canAdvance(kept, identity, found.stat.size)) {
        const from = advanceFrom(kept);
        const length = found.stat.size - from;
        const bytes =
          length <= 0
            ? new Uint8Array(0)
            : await found.home.readBytes(found.file, { offset: from, length }).catch(() => undefined);
        cursor = bytes === undefined ? undefined : advanceCursor(kept, bytes, found.stat.size);
      }
      if (cursor === undefined) {
        const tail = await found.home.readTail(found.file, TAIL_READ_BYTES).catch(() => undefined);
        if (tail === undefined) {
          cursors.delete(ferret);
          return { kind: 'unreadable' };
        }
        cursor = openCursor(identity ?? '', tail.bytes, tail.size, TAIL_READ_BYTES);
      }
      // A file with no identity is never advanced: the next look reads it whole again.
      if (identity === undefined) cursors.delete(ferret);
      else remember(ferret, cursor);
      // A window that reads no message, work or turn boundary whole cannot say where the turn stands (see
      // `markCutWindow`); the window is never widened: one wider parse is a synchronous slice on the daemon's main thread
      // (ruling #44).
      return { kind: 'read', records: windowRecords(cursor, limit) };
    },
  };
};
