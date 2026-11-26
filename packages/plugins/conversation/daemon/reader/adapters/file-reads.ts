import type { FerretId, HarnessTranscriptBytes, TranscriptFormatId } from '@ferretry/core-ferrets/contract';
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
import { CODEX_HEADER_BYTES, CodexTranscriptParser, codexConversationId } from '../lib/transcript/codex.ts';
import type { TranscriptParser } from '../lib/transcript/types.ts';
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

/**
 * How long a held handle stays proved to be the ferret's transcript without asking the harness again. The harness's
 * proof (which file the ferret's conversation names) costs several fenced reads, and every read asked it again; a
 * change of conversation inside this moment is the only thing the memory can miss, and the handle's own stat still
 * refuses a file that was replaced or removed.
 */
const HELD_PROOF_MS = 2_000;
/** The most ferrets whose proof is remembered. */
const MAX_PROVED = 512;

/** The byte sources (one per parser id) and the index over them. */
interface Built {
  readonly sources: ReadonlyMap<TranscriptFormatId, BytesTranscriptSource>;
  readonly index: ConversationIndex;
}

type Located =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unsupported' }
  | {
      readonly kind: 'found';
      readonly token: string;
      readonly format: TranscriptFormatId;
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
  /**
   * One byte source per transcript parser id (`HarnessFacts.transcriptFormat`): a harness whose id is not here is
   * unsupported. Built on the first read, not at construction: a plugin's parser is contributed through a hook that is
   * complete only once every plugin has been built.
   */
  #built: Built | undefined;
  readonly #scanner: BytesRecordScanner;
  readonly #tails: TranscriptTailCache;
  /** Per ferret, the token its held handle was proved under, when, and in which generation (see {@link HELD_PROOF_MS}). */
  readonly #proved = new Map<string, { readonly token: string; readonly at: number; readonly generation: number }>();
  /** Per ferret, the conversation id read from the head of the transcript held under a token (a held file's head does not change). */
  readonly #conversations = new Map<string, { readonly token: string; readonly id: string }>();

  /**
   * `extraParsers`: asked once, on the first read, for the parsers other harnesses declare (a harness's `HarnessFacts.transcriptFormat` names one by its
   * `harness` id). The built-ins are `claude` and `codex`; an extra parser under a built-in id is ignored, never a
   * replacement, so a plugin cannot change how Claude's or Codex's bytes are read.
   */
  constructor(
    private readonly open: TranscriptOpener,
    private readonly clock: TranscriptClock,
    private readonly fallback?: EntriesFallback,
    private readonly extraParsers: () => readonly TranscriptParser[] = () => [],
  ) {
    this.#scanner = new BytesRecordScanner(this.runtime);
    // No file watch exists in 5.0, so a remembered tail is re-validated by one cheap stat on every ask.
    this.#tails = new TranscriptTailCache();
  }

  /** The byte sources and the conversation index, over the parsers declared by now (built once, on first use). */
  #state(): Built {
    if (this.#built !== undefined) return this.#built;
    const parsers = FileTranscriptReads.parsersById(this.extraParsers());
    const sources = [...parsers.values()].map(parser => new BytesTranscriptSource(parser, this.runtime, this.clock));
    this.#built = {
      sources: new Map(sources.map(source => [source.harness, source])),
      index: new ConversationIndex(sources, this.runtime, this.clock.pacing),
    };
    return this.#built;
  }

  /** The parser registry: the two built-ins first, then each extra parser whose id is new. */
  private static parsersById(extra: readonly TranscriptParser[]): ReadonlyMap<TranscriptFormatId, TranscriptParser> {
    const parsers = new Map<TranscriptFormatId, TranscriptParser>();
    for (const parser of [new ClaudeTranscriptParser(), new CodexTranscriptParser(), ...extra])
      if (!parsers.has(parser.harness)) parsers.set(parser.harness, parser);
    return parsers;
  }

  /** The paced parsers the image reader parses a record with: the same pacing as every other parse here. */
  static pacedParsers(
    pacing: TranscriptParsePacing,
    extraParsers: readonly TranscriptParser[] = [],
  ): Readonly<Record<TranscriptFormatId, PacedTranscriptParser>> {
    return Object.fromEntries(
      [...FileTranscriptReads.parsersById(extraParsers)].map(([id, parser]) => [
        id,
        new PacedTranscriptParser(parser, pacing),
      ]),
    );
  }

  /** v4's `createTranscriptLocation`: which transcript is the ferret's, the source that reads it, its token and size. */
  async #located(ferret: string): Promise<Located> {
    // Captured BEFORE the harness is asked: a release (the ferret stopped) while it opens makes this handle a late one.
    const generation = this.runtime.generation(ferret);
    const reused = await this.#reuse(ferret, generation);
    if (reused !== undefined) return reused;
    const opened = await this.open(ferret as FerretId);
    if (opened === 'unsupported') return { kind: this.fallback === undefined ? 'unresolved' : 'unsupported' };
    if (opened === undefined) return { kind: 'unresolved' };
    // The runtime now owns the handle (this reader opened it, and never closes it itself): it keeps ONE per ferret,
    // closes a duplicate or a replaced one, and closes them all when the reader stops.
    const token = await this.runtime.adopt(opened, ferret, generation);
    const held = this.runtime.handle(token);
    const stat = await held?.stat().catch(() => undefined);
    // A release during the stat has already closed the handle: nothing of this read may go on through it.
    if (held === undefined || stat === undefined || this.runtime.released(ferret, generation)) {
      this.#proved.delete(ferret);
      return { kind: 'unreadable' };
    }
    // No parser speaks this harness's declared format: its bytes are never read as another format. The entries
    // fallback, when the composition has one, answers instead.
    const source = this.#state().sources.get(held.format);
    if (source === undefined) return { kind: this.fallback === undefined ? 'unresolved' : 'unsupported' };
    this.#remember(ferret, token, generation);
    return {
      kind: 'found',
      token,
      format: held.format,
      source,
      handle: held,
      size: stat.size,
    };
  }

  #nowMs(): number {
    return Date.parse(this.clock.now());
  }

  #remember(ferret: string, token: string, generation: number): void {
    this.#proved.delete(ferret);
    this.#proved.set(ferret, { token, at: this.#nowMs(), generation });
    for (const oldest of this.#proved.keys()) {
      if (this.#proved.size <= MAX_PROVED) break;
      this.#proved.delete(oldest);
    }
  }

  /**
   * The handle already held for the ferret, when it was proved to be the ferret's transcript a moment ago: the handle's
   * own stat proves the NAME still reaches the very file it holds on every ask (a replaced or removed file answers
   * nothing and a fresh open follows), so only a ferret that switched to ANOTHER conversation is seen up to
   * {@link HELD_PROOF_MS} late. Without this every ask opened a new handle, which the runtime then closed as a duplicate.
   */
  async #reuse(ferret: string, generation: number): Promise<Located | undefined> {
    const proved = this.#proved.get(ferret);
    if (proved === undefined) return undefined;
    const age = this.#nowMs() - proved.at;
    if (proved.generation !== generation || !(age >= 0 && age < HELD_PROOF_MS)) {
      this.#proved.delete(ferret);
      return undefined;
    }
    const held = this.runtime.handle(proved.token);
    const stat = await held?.stat().catch(() => undefined);
    if (held === undefined || stat === undefined || this.runtime.released(ferret, generation)) {
      this.#proved.delete(ferret);
      return undefined;
    }
    const source = this.#state().sources.get(held.format);
    if (source === undefined) return undefined;
    return {
      kind: 'found',
      token: proved.token,
      format: held.format,
      source,
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
    if (events === undefined) return { kind: 'unreadable' };
    const conversation = await this.#conversation(ferret, where);
    return conversation === undefined ? { kind: 'read', events } : { kind: 'read', events, conversation };
  }

  /**
   * The harness's own id of the conversation the held file holds (see {@link codexConversationId}). It is read from the
   * file's head, never from its name: a renamed file is the same conversation under a new token. Only Codex's format
   * names one; a head that cannot be read says nothing.
   */
  async #conversation(ferret: string, where: Extract<Located, { kind: 'found' }>): Promise<string | undefined> {
    if (where.format !== 'codex') return undefined;
    const known = this.#conversations.get(ferret);
    if (known?.token === where.token) return known.id;
    const head = await where.handle.read(0, CODEX_HEADER_BYTES).catch(() => undefined);
    if (head === undefined) return undefined;
    const id = codexConversationId(new TextDecoder().decode(head));
    // A header not yet whole is asked again next time; a whole one is remembered under the file's token.
    if (id !== undefined) this.#conversations.set(ferret, { token: where.token, id });
    return id;
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
      rows = await this.#state().index.rows({ sessionId: ferret, harness: where.format }, where.token);
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

  /** Closes the transcript handle held for one ferret (it stopped or was removed); a later read opens a fresh one. */
  release(ferret: string): void {
    this.#conversations.delete(ferret);
    this.runtime.releaseOwner(ferret);
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
