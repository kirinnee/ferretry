/**
 * Reading one session's transcript — the capability the whole provenance record exists to enable.
 *
 * `TranscriptSource.read` takes an exact FILE. That is why it was unreachable: nothing in the
 * daemon could name one. With provenance persisted this is the join that makes it reachable, and
 * it is deliberately small — resolve the file, pick the source that speaks that harness, read.
 *
 * A SESSION WITH NO TRANSCRIPT READS AS EMPTY, NOT AS AN ERROR. That is the honest projection of
 * "the daemon cannot prove which file is yours", and every consumer already has to handle a
 * transcript with no matching evidence in it. What must never happen instead is a fallback to some
 * other session's file.
 */

import type { ConversationMessagePoint } from '@ferretry/protocol';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowStart,
} from '../../transcript/types.ts';
import {
  type ConversationDigest,
  ConversationDigestError,
  digestConversation,
  type PortableConversationRow,
  portableConversationRows,
} from './digest.ts';

/** The session facts a transcript read needs, projected out of whatever served them. */
export interface TranscriptTarget {
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
}

/** Resolves a session's transcript file, discovering it when the record allows. */
export interface TranscriptFileResolver {
  file(sessionId: string): Promise<string | undefined>;
}

/** Proves the session's daemon-owned journal is present before a restartable digest is made. */
export interface TranscriptDigestJournal {
  assertReadable(sessionId: string): Promise<void>;
}

/**
 * A held fold of each session's portable rows, extended by what was appended (`ConversationIndex`).
 *
 * A port rather than the class so the reader can be handed one without knowing how it holds its folds.
 */
export interface TranscriptRowsIndex {
  rows(target: TranscriptTarget, file: string): Promise<readonly PortableConversationRow[] | undefined>;
}

/** The most recent window of a transcript, which is all any in-flight question needs. */
export const DEFAULT_TRANSCRIPT_TAIL = 400;

/**
 * How many bytes from a transcript's END a tail reads.
 *
 * A tail answers "what is happening now", and what is happening now is at the end of the file. It
 * used to be the last N events of a read that started at byte zero and stopped at a cap, so a
 * conversation bigger than the cap — an adopted one, a long-lived one — answered every such question
 * from history: the turn state, the pending question, the logs all described an old moment and said
 * nothing was wrong. The tail is now read from the end, and its cost no longer grows with the file.
 */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * The steps a drained window may take before it stops: a file growing faster than a step reads
 * would otherwise keep one caller reading forever.
 */
const WINDOW_STEP_LIMIT = 64;

/**
 * The first window a tail tries, before it grows towards its byte bound.
 *
 * A tail was always the last 16 MiB, parsed in one synchronous step — a third of a second of a blocked
 * event loop per 200 MB conversation, every time — although the newest few hundred events of a
 * conversation almost always sit in its last megabyte or two. A tail now starts small and widens only
 * while it has found fewer events than it was asked for and there are older bytes it has not read, so
 * the common answer costs a small parse and the rare one still reaches the same bound it always had.
 */
const TAIL_GROWTH_BYTES: readonly number[] = [512 * 1024, 2 * 1024 * 1024];

/**
 * The last `limit` events of `file`, read from its end in bounded steps.
 *
 * Only the newest `limit` events are ever held, so memory is bounded by the limit and one step, not
 * by the file. The window starts small and grows to at most `bytes` (see {@link TAIL_GROWTH_BYTES});
 * because every window ends at the end of the file, the newest `limit` events of a smaller window that
 * found `limit` of them are exactly the newest `limit` events of the largest.
 */
export async function tailTranscriptEvents(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  limit = DEFAULT_TRANSCRIPT_TAIL,
  bytes = DEFAULT_TRANSCRIPT_TAIL_BYTES,
): Promise<readonly TranscriptEvent[]> {
  return (await openTail(source, file, sessionId, limit, bytes)).events;
}

/** One tail, as {@link tailTranscriptEvents} reads it, with the window it was read through. */
interface OpenedTail {
  readonly events: readonly TranscriptEvent[];
  /** The last window tried, and how many bytes from the end it began. */
  readonly window: TranscriptWindow;
  readonly bytes: number;
  readonly fromStart: boolean;
  /** Whether the window was read to the end of the file, rather than stopped at its step limit. */
  readonly complete: boolean;
  /** How much of the file the window has read: its byte offset plus the partial line it carries. */
  readonly offset: number;
}

async function openTail(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  limit: number,
  bytes: number,
): Promise<OpenedTail> {
  const windows = [...TAIL_GROWTH_BYTES.filter(size => size < bytes), bytes];
  let opened: OpenedTail | undefined;
  for (const size of windows) {
    opened = await tailWindow(source, file, sessionId, limit, size);
    if (opened.events.length >= limit || opened.fromStart) break;
  }
  return opened as OpenedTail;
}

/** One tail window: its newest `limit` events, and whether it began at the start of the file. */
async function tailWindow(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  limit: number,
  bytes: number,
): Promise<OpenedTail> {
  const window = source.window(file, { sessionId, start: { at: 'tail', bytes } });
  let events: TranscriptEvent[] = [];
  // A window that began mid-file cannot number its lines, so a first batch that does began at byte
  // zero: there is nothing older for a wider window to find. A placed window always answers its first
  // step with a batch (see `NodeTranscriptWindow`), so no batch at all is an empty or unplaceable file.
  let fromStart: boolean | undefined;
  let complete = false;
  let offset = 0;
  for (let step = 0; step < WINDOW_STEP_LIMIT; step += 1) {
    const { batch, more } = await window.next();
    if (batch !== undefined && fromStart === undefined) fromStart = batch.cursor.nextLine !== undefined;
    if (batch?.reset === true) events = [];
    if (batch !== undefined) {
      events = [...events, ...batch.events].slice(-limit);
      offset = batch.cursor.byteOffset + batch.cursor.pendingBytes;
    }
    if (!more) {
      complete = true;
      break;
    }
  }
  return { events, window, bytes, fromStart: fromStart ?? true, complete, offset };
}

/**
 * A transcript's tail, KEPT CURRENT BY READING ONLY WHAT WAS APPENDED: the same events
 * {@link tailTranscriptEvents} would read from the file as it is now, without re-reading its window.
 *
 * An agent that is working appends to its transcript before almost every look, and a fresh tail re-reads
 * and re-parses its whole window — hundreds of kilobytes — each time. This holds the window the tail was
 * read through and steps it: it remembers its byte offset and carries a partial last line until its
 * newline arrives (see `TranscriptWindow`), and the new events slide into the newest `limit`.
 *
 * EXACTLY THE FRESH TAIL, OR A FRESH TAIL. Sliding is only the same answer while the window began
 * mid-file, already held `limit` events, and still spans no more than the `bytes` bound: then every
 * fresh window that finds `limit` events finds these, and a window that began at byte zero (whose events
 * carry line numbers a mid-file one cannot) is never compared with one that did not. Anything else — a
 * small or sparse transcript, a replaced or truncated file, a read that failed or did not reach the end,
 * a window grown past its bound — reads the tail afresh, as before.
 */
export class IncrementalTranscriptTail {
  private opened: OpenedTail | undefined;
  /** How much of the file the window had read when it was opened. */
  private openedAt = 0;
  private events: readonly TranscriptEvent[] = [];

  constructor(
    private readonly source: TranscriptSource,
    readonly file: string,
    private readonly sessionId: string,
    private readonly limit = DEFAULT_TRANSCRIPT_TAIL,
    private readonly bytes = DEFAULT_TRANSCRIPT_TAIL_BYTES,
  ) {}

  /** The tail now. Throws when it cannot be read, as {@link tailTranscriptEvents} does. */
  async read(): Promise<readonly TranscriptEvent[]> {
    const opened = this.opened;
    if (opened !== undefined && this.slides(opened)) {
      const slid = await this.slide(opened).catch(() => undefined);
      if (slid !== undefined) return slid;
    }
    return await this.reopen();
  }

  private slides(opened: OpenedTail): boolean {
    return opened.complete && !opened.fromStart && this.events.length >= this.limit && this.bounded(opened.offset);
  }

  /** Whether a window that has read to `offset` still begins inside the widest window a fresh tail reads. */
  private bounded(offset: number): boolean {
    return offset - this.openedAt + (this.opened?.bytes ?? this.bytes) <= this.bytes;
  }

  /** The appended records, stepped through the held window; `undefined` when only a fresh tail will do. */
  private async slide(opened: OpenedTail): Promise<readonly TranscriptEvent[] | undefined> {
    let events = this.events;
    let offset = opened.offset;
    for (let step = 0; step < WINDOW_STEP_LIMIT; step += 1) {
      const { batch, more } = await opened.window.next();
      if (batch?.reset === true) return undefined;
      if (batch !== undefined) {
        events = [...events, ...batch.events].slice(-this.limit);
        offset = batch.cursor.byteOffset + batch.cursor.pendingBytes;
      }
      if (!more) {
        // Past its bound the window holds bytes a fresh tail would not read.
        if (!this.bounded(offset)) return undefined;
        this.opened = { ...opened, offset };
        this.events = events;
        return events;
      }
    }
    return undefined;
  }

  private async reopen(): Promise<readonly TranscriptEvent[]> {
    this.opened = undefined;
    this.events = [];
    const opened = await openTail(this.source, this.file, this.sessionId, this.limit, this.bytes);
    this.opened = opened;
    this.openedAt = opened.offset;
    this.events = opened.events;
    return opened.events;
  }
}

/**
 * Every step of `window` until it reaches the end of the file, handed to `visit` one at a time and
 * never collected: the visitor keeps what it needs. Answers whether the end was reached.
 */
export async function drainTranscriptWindow(
  window: TranscriptWindow,
  visit: (batch: TranscriptBatch) => void,
): Promise<boolean> {
  for (let step = 0; step < WINDOW_STEP_LIMIT; step += 1) {
    const { batch, more } = await window.next();
    if (batch !== undefined) visit(batch);
    if (!more) return true;
  }
  return false;
}

export class SessionTranscriptReader {
  private readonly bySource: ReadonlyMap<TranscriptHarness, TranscriptSource>;

  constructor(
    sources: readonly TranscriptSource[],
    private readonly resolver: TranscriptFileResolver,
    private readonly journal?: TranscriptDigestJournal,
    private readonly index?: TranscriptRowsIndex,
  ) {
    this.bySource = new Map(sources.map(source => [source.harness, source]));
  }

  /**
   * The tail of a session's transcript, or nothing.
   *
   * A read that throws — the file was deleted between resolution and open, the harness home was
   * unmounted — answers empty for the same reason an unresolved session does: this is evidence, and
   * missing evidence is not a reason to fail the operation that asked for it. The caller sees the
   * same shape either way and reports the absence in its own vocabulary.
   */
  async tail(target: TranscriptTarget, limit = DEFAULT_TRANSCRIPT_TAIL): Promise<readonly TranscriptEvent[]> {
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    const source = this.bySource.get(target.harness);
    if (file === undefined || source === undefined) return [];
    return await tailTranscriptEvents(source, file, target.sessionId, limit).catch(() => []);
  }

  /**
   * An append-only window over this session's transcript, or nothing when the daemon cannot name the
   * file. A caller holds the window and steps it again later, reading only what was appended since.
   */
  async window(target: TranscriptTarget, start: TranscriptWindowStart): Promise<TranscriptWindow | undefined> {
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    const source = this.bySource.get(target.harness);
    if (file === undefined || source === undefined) return undefined;
    return source.window(file, { sessionId: target.sessionId, start });
  }

  /** The file this session's transcript resolves to now, so a held window can tell it was re-bound. */
  async file(target: TranscriptTarget): Promise<string | undefined> {
    return await this.resolver.file(target.sessionId).catch(() => undefined);
  }

  /**
   * A complete, provenance-resolved transcript batch for a durable consumer.
   *
   * Unlike `tail`, this preserves parser issues so callers that need a complete conversation can
   * refuse rather than mistake a bounded or damaged read for an empty suffix.
   */
  async read(target: TranscriptTarget): Promise<TranscriptBatch | undefined> {
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    if (file === undefined) return undefined;
    return await this.readFile(target, file);
  }

  /**
   * Whether this session has a transcript the daemon can name, discovering it when the record allows.
   *
   * `false` is the unresolved case `read` folds into "nothing": no file this daemon can prove is the
   * session's own. A caller that must say WHY there is no evidence asks this rather than guessing.
   */
  async bound(target: TranscriptTarget): Promise<boolean> {
    return (await this.resolver.file(target.sessionId).catch(() => undefined)) !== undefined;
  }

  /**
   * The same read, against a file the caller has ALREADY resolved.
   *
   * The resolution step is separated because it is not free of consequence: the discovering resolver
   * correlates a rollout and records that attribution back into the session, so a caller that must
   * resolve once, re-read the session's persisted configuration, and only then read the transcript
   * cannot go back through `resolver.file` without doing it twice. This is one byte read of exactly
   * the file it was handed, and it discovers nothing.
   */
  private async readFile(target: TranscriptTarget, file: string): Promise<TranscriptBatch | undefined> {
    const source = this.bySource.get(target.harness);
    if (source === undefined) return undefined;
    return await source.read(file, { sessionId: target.sessionId }).catch(() => undefined);
  }

  /**
   * The portable prefix ending at a durable message coordinate.
   *
   * This does not follow a running harness. The underlying source reads the exact transcript file
   * provenance recorded for this session, and `digestConversation` refuses every incomplete batch.
   */
  async digest(target: TranscriptTarget, through: ConversationMessagePoint): Promise<ConversationDigest> {
    if (this.journal === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `session ${target.sessionId} has no daemon journal proof for a restartable transcript digest`,
      );
    await this.journal.assertReadable(target.sessionId);
    const batch = await this.read(target);
    if (batch === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${target.sessionId} cannot be resolved and read completely`,
      );
    return digestConversation(target.sessionId, batch, through);
  }

  /**
   * Every portable message of this session's transcript, each bound to the commitment for the
   * physical record it came from.
   *
   * ONE read serves the whole page. The rows a caller may select and the evidence it binds them
   * with come from the same complete batch, so nothing here can offer a row whose prefix it did not
   * see. A batch that carries no record bytes refuses inside the digest rather than being served
   * without evidence.
   *
   * `undefined` keeps the reader's existing distinction: the daemon cannot name or read a transcript
   * for this session at all, which is missing evidence rather than damaged evidence. A transcript
   * that EXISTS and cannot honestly yield rows throws `ConversationDigestError` instead, and the two
   * answers stay distinct all the way to the caller.
   */
  async portableRows(target: TranscriptTarget): Promise<readonly PortableConversationRow[] | undefined> {
    await this.requireJournalProof(target);
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    if (file === undefined) return undefined;
    return await this.rowsFrom(target, file);
  }

  /**
   * The same page, against an ALREADY-RESOLVED transcript file: journal proof, then ONE byte read.
   *
   * This is the operation production composes with, because resolution has to happen first and
   * separately — the discovering resolver may persist an attribution, and the caller re-reads the
   * session's completed configuration, provenance and incarnation before it reads a single
   * transcript byte. Coming back through the resolver here would resolve a second time, against
   * facts the caller has already pinned.
   */
  async portableRowsFromFile(
    target: TranscriptTarget,
    file: string,
  ): Promise<readonly PortableConversationRow[] | undefined> {
    await this.requireJournalProof(target);
    return await this.rowsFrom(target, file);
  }

  /**
   * The rows of one resolved file: from the conversation index when this reader has one, which folds
   * only what was appended since its last read, or from one complete read when it does not.
   */
  private async rowsFrom(
    target: TranscriptTarget,
    file: string,
  ): Promise<readonly PortableConversationRow[] | undefined> {
    if (this.index !== undefined) return await this.index.rows(target, file);
    return this.rowsOf(target, await this.readFile(target, file));
  }

  private rowsOf(
    target: TranscriptTarget,
    batch: TranscriptBatch | undefined,
  ): readonly PortableConversationRow[] | undefined {
    return batch === undefined ? undefined : portableConversationRows(target.sessionId, batch);
  }

  private async requireJournalProof(target: TranscriptTarget): Promise<void> {
    if (this.journal === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `session ${target.sessionId} has no daemon journal proof for a restartable transcript read`,
      );
    await this.journal.assertReadable(target.sessionId);
  }
}
