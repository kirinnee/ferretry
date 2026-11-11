import type { FerretId, HarnessTranscriptBytes } from '@ferretry/core-ferrets/contract';
import type {
  MessageRowReadResult,
  MessageRowSource,
  SessionTranscriptPages,
  SessionTranscriptSearch,
  SessionTranscriptTail,
  TranscriptPageResult,
  TranscriptSearchReadResult,
  TranscriptTailResult,
} from '../lib/reads.ts';
import { ConversationDigestError } from '../lib/session/digest.ts';
import { ConversationIndex } from '../lib/session/conversation-index.ts';
import type { TranscriptImageLocator, TranscriptImageTarget } from '../lib/session/image-reader.ts';
import { readTranscriptPage, tailPage } from '../lib/session/log-page.ts';
import { searchTranscriptRecords } from '../lib/session/log-search.ts';
import { tailTranscriptEvents } from '../lib/session/reader.ts';
import { TranscriptTailCache } from '../lib/session/tail-cache.ts';
import { ClaudeTranscriptParser } from '../lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../lib/transcript/codex.ts';
import { PacedTranscriptParser, type TranscriptParsePacing } from '../lib/transcript/sliced.ts';
import { BytesTranscriptSource, type TranscriptClock } from './file-source.ts';
import { HarnessBytesRuntime } from './harness-bytes-runtime.ts';
import { BytesRecordScanner } from './record-scan.ts';

/**
 * What asking a ferret's harness for its transcript bytes can answer:
 * - a handle: the harness proved this ferret's transcript and gives it as raw, UNMASKED bytes;
 * - `undefined`: the harness offers bytes but has proved no transcript for this ferret yet;
 * - `unsupported`: the harness offers no bytes at all (a harness that only keeps entries), so the caller reads entries.
 *
 * Rejects with the seam's own refusal (503 `plugin_unavailable`) while the ferret's harness is off.
 */
type OpenedTranscript = HarnessTranscriptBytes | undefined | 'unsupported';
export type TranscriptOpener = (ferret: FerretId) => Promise<OpenedTranscript>;

/** What each read falls back to when the harness offers no bytes: the entries reads (one port per read). */
export type EntriesFallback = SessionTranscriptTail &
  SessionTranscriptPages &
  SessionTranscriptSearch &
  MessageRowSource;

type Located =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unsupported' }
  | {
      readonly kind: 'found';
      readonly token: string;
      readonly format: 'claude' | 'codex';
      readonly source: BytesTranscriptSource;
      readonly handle: HarnessTranscriptBytes;
      readonly size: number;
    };

/**
 * A ferret's transcript read from the harness's own raw bytes: v4's reader composition (`fyd.ts`: location, tail,
 * pages, search, addressable messages, image location) keyed by ferret and over {@link HarnessBytesRuntime}.
 *
 * It holds RAW bytes, and its answers are RAW events and rows: every one goes through `reads.ts`'s read-scoped
 * redactor before it leaves (the masking point is unchanged from v4). Nothing here names a path; a transcript is
 * known by the harness's opaque token, and a replaced file has a new token, which is what makes older pages
 * (`log_cursor_stale`) and message cursors stale.
 */
export class FileTranscriptReads
  implements
    SessionTranscriptTail,
    SessionTranscriptPages,
    SessionTranscriptSearch,
    MessageRowSource,
    TranscriptImageLocator
{
  readonly runtime = new HarnessBytesRuntime();
  readonly #sources: Readonly<Record<'claude' | 'codex', BytesTranscriptSource>>;
  readonly #index: ConversationIndex;
  readonly #scanner: BytesRecordScanner;
  readonly #tails: TranscriptTailCache;

  constructor(
    private readonly open: TranscriptOpener,
    clock: TranscriptClock,
    private readonly fallback?: EntriesFallback,
  ) {
    const claude = new BytesTranscriptSource(new ClaudeTranscriptParser(), this.runtime, clock);
    const codex = new BytesTranscriptSource(new CodexTranscriptParser(), this.runtime, clock);
    this.#sources = { claude, codex };
    this.#index = new ConversationIndex([claude, codex], this.runtime, clock.pacing);
    this.#scanner = new BytesRecordScanner(this.runtime);
    // No file watch exists in 5.0, so a remembered tail is re-validated by one cheap stat on every ask.
    this.#tails = new TranscriptTailCache();
  }

  /** The paced parsers the image reader parses a record with: the same pacing as every other parse here. */
  static pacedParsers(pacing: TranscriptParsePacing): Readonly<Record<'claude' | 'codex', PacedTranscriptParser>> {
    return {
      claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), pacing),
      codex: new PacedTranscriptParser(new CodexTranscriptParser(), pacing),
    };
  }

  /** v4's `createTranscriptLocation`: which transcript is the ferret's, the source that reads it, its token and size. */
  async #located(ferret: string): Promise<Located> {
    const opened = await this.open(ferret as FerretId);
    if (opened === 'unsupported') return { kind: this.fallback === undefined ? 'unresolved' : 'unsupported' };
    if (opened === undefined) return { kind: 'unresolved' };
    // The runtime now owns the handle (this reader opened it, and never closes it itself): it keeps ONE per ferret,
    // closes a duplicate or a replaced one, and closes them all when the reader stops.
    const token = await this.runtime.adopt(opened, ferret);
    const held = this.runtime.handle(token);
    const stat = await held?.stat().catch(() => undefined);
    if (held === undefined || stat === undefined) return { kind: 'unreadable' };
    return {
      kind: 'found',
      token,
      format: held.format,
      source: this.#sources[held.format],
      handle: held,
      size: stat.size,
    };
  }

  async tail(ferret: string, limit: number): Promise<TranscriptTailResult> {
    const where = await this.#located(ferret);
    if (where.kind === 'unsupported') return await (this.fallback as EntriesFallback).tail(ferret, limit);
    if (where.kind !== 'found') return where;
    return await this.#tail(ferret, where, limit);
  }

  async #tail(
    ferret: string,
    where: Extract<Located, { kind: 'found' }>,
    limit: number,
  ): Promise<TranscriptTailResult> {
    // Read from the END: a tail of a capped read from byte zero described an old moment as now.
    const read = async (): Promise<ReturnType<typeof tailTranscriptEvents> | undefined> =>
      await tailTranscriptEvents(where.source, where.token, ferret, limit).catch(() => undefined);
    const fingerprint = async () => {
      const stat = await where.handle.stat().catch(() => undefined);
      return stat === undefined ? undefined : { file: where.token, size: stat.size, mtimeMs: stat.mtimeMs };
    };
    const events = await this.#tails.tail(ferret, where.token, limit, fingerprint, async () => await read());
    return events === undefined ? { kind: 'unreadable' } : { kind: 'read', events };
  }

  async page(
    ferret: string,
    query: { readonly before?: number; readonly from?: number; readonly limit: number },
  ): Promise<TranscriptPageResult> {
    const where = await this.#located(ferret);
    if (where.kind === 'unsupported') return await (this.fallback as EntriesFallback).page(ferret, query);
    if (where.kind !== 'found') return where;
    if (query.before === undefined) {
      const tail = await this.#tail(ferret, where, query.limit);
      if (tail.kind !== 'read') return tail;
      const page = tailPage(tail.events, query.limit, where.size);
      if (page !== undefined) return { kind: 'read', ...page, file: where.token };
    }
    const before = Math.min(query.before ?? where.size, where.size);
    const range = { from: query.from ?? 0, before, limit: query.limit };
    const page = await readTranscriptPage(where.source, where.token, ferret, range).catch(() => undefined);
    if (page === undefined) return { kind: 'unreadable' };
    return { kind: 'read', ...page, file: where.token };
  }

  // read-scoped: none — returns raw events to the reads service, which masks every snippet through the read-scoped redactor
  async search(
    ferret: string,
    query: {
      readonly needle: string | undefined;
      readonly accept: Parameters<typeof searchTranscriptRecords>[4]['accept'];
      readonly limit: number;
    },
  ): Promise<TranscriptSearchReadResult> {
    const where = await this.#located(ferret);
    if (where.kind === 'unsupported') return await (this.fallback as EntriesFallback).search(ferret, query);
    if (where.kind !== 'found') return where;
    const result = await searchTranscriptRecords(
      where.source,
      this.#scanner,
      where.token,
      ferret,
      query,
      query.limit,
    ).catch(() => undefined);
    if (result === undefined) return { kind: 'unreadable' };
    return { kind: 'read', ...result, file: where.token };
  }

  /**
   * The addressable conversation. The token context is `{ sessionId, incarnation: file token, provenance }`: a
   * replaced file (new token) makes every earlier message cursor stale, and a relaunch that keeps the same file keeps
   * them valid (the same bytes mean the same coordinates).
   */
  async read(ferret: string): Promise<MessageRowReadResult> {
    const where = await this.#located(ferret);
    if (where.kind === 'unsupported') return await (this.fallback as EntriesFallback).read(ferret);
    if (where.kind !== 'found') return where;
    let rows: Awaited<ReturnType<ConversationIndex['rows']>>;
    try {
      rows = await this.#index.rows({ sessionId: ferret, harness: where.format }, where.token);
    } catch (error) {
      // A refusal keeps its reason: a damaged record, a file replaced mid-read and a bound reached read differently.
      return {
        kind: 'unreadable',
        reason: error instanceof ConversationDigestError ? error.message : 'an unexpected error stopped its read',
      };
    }
    if (rows === undefined) return { kind: 'unreadable', reason: 'no transcript source speaks its harness' };
    return {
      kind: 'read',
      context: {
        sessionId: ferret,
        incarnation: where.token,
        provenance: { v: 1, home: where.format, identity: 'minted', harnessSessionId: ferret, file: where.token },
      },
      rows,
    };
  }

  /** Closes every transcript handle this reader opened: the daemon is stopping. */
  async close(): Promise<void> {
    await this.runtime.closeAll();
  }

  /** The image reader's locator: the proved transcript's token is the `file` it reads through {@link runtime}. */
  async locate(ferret: string): Promise<TranscriptImageTarget | undefined> {
    const where = await this.#located(ferret);
    return where.kind === 'found' ? { file: where.token, harness: where.format } : undefined;
  }
}
