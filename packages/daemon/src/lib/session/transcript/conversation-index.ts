/**
 * A SESSION'S ADDRESSABLE CONVERSATION, FOLDED ONCE AND EXTENDED BY WHAT WAS APPENDED.
 *
 * Every row of a messages page carries `H_i`, a hash chain over every raw record from byte zero, so a
 * page used to be one complete read of the whole transcript. That cost the file's size per page, and a
 * complete read stops at 32 MiB, so a long session (hundreds of megabytes) could not be paged at all —
 * and neither could a live one, whose half-written last line read as truncated JSON. This keeps, per
 * session, the rows folded so far and the chain's value where they end, and each read folds only the
 * bytes after that point, through the transcript source's own `beginning` window: bounded reads, cut at
 * the last record terminator, with the unterminated tail held back until its newline arrives.
 *
 * NOTHING IS SERVED OVER A PREFIX THIS DID NOT READ. Every row's `rawPrefix` is the chain over bytes the
 * window actually read, contiguously from byte zero (the fold refuses a gap or an overlap). Before an
 * index is extended it must still describe the file: the same identity, no shorter than what was
 * folded, and the LAST FOLDED RECORD still at its offset with the same bytes — read back and re-hashed
 * from the chain value before it, so a match is a proof, not a guess. The window adds its own anchor
 * over the bytes before its cursor and restarts from zero when it no longer matches. Anything else
 * rebuilds from byte zero.
 *
 * WHAT THAT DOES NOT CATCH, AND WHY IT IS SAFE. A rewrite of the file IN PLACE that leaves it at least as
 * long, its identity unchanged and its last record byte-identical is not seen here: the rows already
 * folded are still served. Each row's binding is still over bytes this daemon read, just earlier, and
 * the binding is evidence, not authority — a fork re-reads the transcript itself and refuses a
 * selection whose prefix no longer matches. Transcripts are appended by their harness, so a same-length
 * edit before the end is not an ordinary input; a replacement (new identity) and a truncation are, and
 * both rebuild.
 *
 * BOUNDED. The rows are what a page needs and nothing more (text, point, role, time, 32 bytes of chain),
 * held for the most recently read sessions up to {@link DEFAULT_CONVERSATION_INDEX_BYTES}; an evicted
 * session simply folds again on its next read. Concurrent reads of one session share one extension.
 */

import type { TranscriptBatch, TranscriptIssue, TranscriptSource, TranscriptWindow } from '../../transcript/types.ts';
import {
  ConversationDigestError,
  extendPortableConversationRows,
  type PortableConversationCheckpoint,
  type PortableConversationLastRecord,
  type PortableConversationPacing,
  type PortableConversationRow,
  startPortableConversation,
} from './digest.ts';
import { extendSessionTranscriptRawPrefix } from './message-token.ts';
import type { TranscriptRowsIndex, TranscriptTarget } from './reader.ts';

/**
 * How many bytes of rows the index holds across every session before it forgets the least recent.
 *
 * Measured on a real 296 MB Claude transcript: 9,384 rows whose text is 11.6 MB in memory — a working
 * session's conversation is a few percent of its transcript, because tool output is not a row. So this
 * keeps the handful of long sessions someone is actually reading, and the one being read is never
 * evicted however large it is: evicting it would make every page of it a whole-file read again.
 */
export const DEFAULT_CONVERSATION_INDEX_BYTES = 64 * 1024 * 1024;

/**
 * The most window steps one read takes before it answers with what it has folded.
 *
 * A step is one bounded read (32 MiB), so this is two gibibytes in one read — far past any transcript
 * seen. It is bounded anyway because a file growing faster than it is read would otherwise hold one
 * caller forever; stopping is honest, because every row folded is a complete prefix of the file.
 */
const DEFAULT_MAX_STEPS = 64;

/** What one row costs beyond its text: the point, the role, the timestamp and the 32-byte chain value. */
const ROW_OVERHEAD_BYTES = 192;

/**
 * Source issues that are a window's ordinary stepping, never a gap in what was folded.
 *
 * `incomplete-line` is the unterminated tail a live writer has not finished: it is NOT folded — the
 * window holds it back — so it is not yet a record, and the next read folds it once its newline
 * lands. `source-truncated` is a step that stopped at the bounded read limit with more to read, and the
 * index reads on. Every other issue is the fold's to judge, and it refuses on each it always has.
 */
const STEPPING_ISSUES: ReadonlySet<TranscriptIssue['code']> = new Set(['incomplete-line', 'source-truncated']);

/** The file facts the index proves itself against; the transcript source's file runtime satisfies it. */
export interface ConversationIndexFiles {
  info(file: string): Promise<{ readonly identity: string; readonly size: number } | undefined>;
  readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array>;
}

export interface ConversationIndexLimits {
  readonly maxBytes?: number;
  readonly maxSteps?: number;
}

/** One session's folded conversation, and the window that continues it. */
interface Folded {
  readonly kind: 'folded';
  readonly window: TranscriptWindow;
  readonly identity: string | undefined;
  readonly rows: PortableConversationRow[];
  readonly checkpoint: PortableConversationCheckpoint;
  readonly lastRecord: PortableConversationLastRecord | undefined;
  /** What the rows occupy, approximately. */
  readonly bytes: number;
  /** The unterminated tail the window is holding until its newline arrives. */
  readonly pending: number;
}

/**
 * A fold that refused, remembered against the file it refused.
 *
 * A damaged record stays damaged: re-reading a quarter-gigabyte transcript on every page only to refuse
 * it again is the cost this index exists to remove. The same identity at the same size is the same
 * bytes as far as an append-only writer is concerned, so it earns the same refusal without a read, and
 * any change at all folds again from zero.
 */
interface Refused {
  readonly kind: 'refused';
  readonly identity: string;
  readonly size: number;
  readonly error: ConversationDigestError;
}

interface Entry {
  readonly file: string;
  readonly harness: TranscriptTarget['harness'];
  state: Folded | Refused | undefined;
  inflight: Promise<readonly PortableConversationRow[]> | undefined;
}

function rowBytes(rows: readonly PortableConversationRow[]): number {
  let bytes = 0;
  for (const row of rows) bytes += row.text.length * 2 + (row.timestamp?.length ?? 0) * 2 + ROW_OVERHEAD_BYTES;
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function unreadable(sessionId: string, why: string): ConversationDigestError {
  return new ConversationDigestError('incomplete_transcript', `transcript for ${sessionId} ${why}`);
}

export class ConversationIndex implements TranscriptRowsIndex {
  private readonly bySource: ReadonlyMap<TranscriptTarget['harness'], TranscriptSource>;
  private readonly entries = new Map<string, Entry>();
  private readonly maxBytes: number;
  private readonly maxSteps: number;

  constructor(
    sources: readonly TranscriptSource[],
    private readonly files: ConversationIndexFiles,
    private readonly pacing: PortableConversationPacing,
    limits: ConversationIndexLimits = {},
  ) {
    this.bySource = new Map(sources.map(source => [source.harness, source]));
    this.maxBytes = limits.maxBytes ?? DEFAULT_CONVERSATION_INDEX_BYTES;
    this.maxSteps = limits.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  /**
   * Every portable row of `file` as it is now, folding only what was appended since the last read.
   *
   * The same rows `portableConversationRows` makes from one complete read of the same bytes, with one
   * deliberate difference: an unterminated last line is not a record yet, so it is left out rather than
   * refused. `undefined` when no source speaks the session's harness, as the reader answers. Throws
   * `ConversationDigestError` when the transcript cannot honestly yield rows.
   */
  async rows(target: TranscriptTarget, file: string): Promise<readonly PortableConversationRow[] | undefined> {
    const source = this.bySource.get(target.harness);
    if (source === undefined) return undefined;
    const held = this.entries.get(target.sessionId);
    const entry: Entry =
      held !== undefined && held.file === file && held.harness === target.harness
        ? held
        : { file, harness: target.harness, state: undefined, inflight: undefined };
    this.touch(target.sessionId, entry);
    if (entry.inflight !== undefined) return await entry.inflight;
    const inflight = this.refresh(target.sessionId, source, entry);
    entry.inflight = inflight;
    try {
      return await inflight;
    } finally {
      entry.inflight = undefined;
      this.evict(target.sessionId);
    }
  }

  /** The approximate bytes every held session's rows occupy. */
  heldBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values())
      if (entry.state?.kind === 'folded') bytes += entry.state.bytes + entry.state.pending;
    return bytes;
  }

  private async refresh(
    sessionId: string,
    source: TranscriptSource,
    entry: Entry,
  ): Promise<readonly PortableConversationRow[]> {
    for (let attempt = 0; ; attempt += 1) {
      const info = await this.info(sessionId, entry.file);
      const held = entry.state;
      if (held?.kind === 'refused' && held.identity === info.identity && held.size === info.size) throw held.error;
      const kept = held?.kind === 'folded' && (await this.stillHolds(entry.file, info, held)) ? held : undefined;
      let folded: Folded;
      try {
        folded = await this.extend(sessionId, kept ?? this.fresh(source, entry.file, sessionId));
      } catch (error) {
        entry.state =
          error instanceof ConversationDigestError
            ? { kind: 'refused', identity: info.identity, size: info.size, error }
            : undefined;
        throw error;
      }
      // The window reads, then checks the file is still the one it read; a file replaced in between
      // leaves the window where it was, so the identity it folded is proved against the file again.
      const after = await this.info(sessionId, entry.file);
      if (after.identity === folded.identity && after.size >= folded.checkpoint.end) {
        entry.state = folded;
        return folded.rows.slice();
      }
      entry.state = undefined;
      if (attempt > 0) throw unreadable(sessionId, 'changed while it was being read');
    }
  }

  private async info(sessionId: string, file: string): Promise<{ readonly identity: string; readonly size: number }> {
    let info: { readonly identity: string; readonly size: number } | undefined;
    try {
      info = await this.files.info(file);
    } catch {
      throw unreadable(sessionId, 'metadata could not be read');
    }
    if (info === undefined) throw unreadable(sessionId, 'is not available');
    return info;
  }

  /**
   * Whether a held fold still describes the file: its identity, its length, and its last record's bytes
   * re-hashed from the chain value before it — the one proof that the prefix the rows end at is there.
   */
  private async stillHolds(
    file: string,
    info: { readonly identity: string; readonly size: number },
    folded: Folded,
  ): Promise<boolean> {
    if (folded.identity !== info.identity || info.size < folded.checkpoint.end) return false;
    const last = folded.lastRecord;
    if (last === undefined) return true;
    const bytes = await this.files.readRange(file, last.byteOffset, last.byteLength).catch(() => undefined);
    if (bytes?.byteLength !== last.byteLength) return false;
    return bytesEqual(extendSessionTranscriptRawPrefix(last.before, bytes), folded.checkpoint.rawPrefix);
  }

  private fresh(source: TranscriptSource, file: string, sessionId: string): Folded {
    return {
      kind: 'folded',
      window: source.window(file, { sessionId, start: { at: 'beginning' } }),
      identity: undefined,
      rows: [],
      checkpoint: startPortableConversation(),
      lastRecord: undefined,
      bytes: 0,
      pending: 0,
    };
  }

  /** Steps the window to the end of the file, folding each batch onto `from`. */
  private async extend(sessionId: string, from: Folded): Promise<Folded> {
    let folded = from;
    for (let step = 0; step < this.maxSteps; step += 1) {
      const { batch, more } = await folded.window.next();
      if (batch !== undefined) folded = await this.fold(sessionId, batch.reset ? restarted(folded) : folded, batch);
      if (!more) break;
    }
    return folded;
  }

  private async fold(sessionId: string, folded: Folded, batch: TranscriptBatch): Promise<Folded> {
    const extension = await extendPortableConversationRows(
      sessionId,
      folded.checkpoint,
      { ...batch, issues: batch.issues.filter(issue => !STEPPING_ISSUES.has(issue.code)) },
      this.pacing,
    );
    for (const row of extension.rows) folded.rows.push(row);
    return {
      ...folded,
      identity: batch.cursor.identity ?? folded.identity,
      checkpoint: extension.checkpoint,
      lastRecord: extension.lastRecord ?? folded.lastRecord,
      bytes: folded.bytes + rowBytes(extension.rows),
      pending: batch.cursor.pendingBytes,
    };
  }

  /** Marks `sessionId` as the most recently read, holding `entry` for it. */
  private touch(sessionId: string, entry: Entry): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  /** Forgets the least recently read sessions past the byte bound, never `current` and never one mid-read. */
  private evict(current: string): void {
    let bytes = this.heldBytes();
    for (const [sessionId, entry] of this.entries) {
      if (bytes <= this.maxBytes) return;
      if (sessionId === current || entry.inflight !== undefined) continue;
      if (entry.state?.kind === 'folded') bytes -= entry.state.bytes + entry.state.pending;
      this.entries.delete(sessionId);
    }
  }
}

/** The window restarted from byte zero (the file was replaced or rewritten), so the fold does too. */
function restarted(folded: Folded): Folded {
  return { ...folded, rows: [], checkpoint: startPortableConversation(), lastRecord: undefined, bytes: 0, pending: 0 };
}
