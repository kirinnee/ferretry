/** Transcript formats supported by the daemon. */
export type TranscriptHarness = 'claude' | 'codex';

/** The author represented by a normalized transcript event. */
export type TranscriptRole = 'user' | 'assistant' | 'developer' | 'system' | 'tool';

/** JSON data retained from a harness record after normalization. */
export type TranscriptJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly TranscriptJsonValue[]
  | { readonly [key: string]: TranscriptJsonValue };

export interface TranscriptQuestionOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

export interface TranscriptQuestion {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly TranscriptQuestionOption[];
  readonly multiple: boolean;
}

export interface TranscriptEventMetadata {
  readonly harness: TranscriptHarness;
  readonly role: TranscriptRole;
  readonly source?: string;
  readonly line?: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
  readonly timestamp?: string;
  readonly sessionId?: string;
  readonly recordId?: string;
  readonly parentRecordId?: string | null;
  readonly itemId?: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly phase?: string;
  readonly stopReason?: string;
  /**
   * How a user message reached the harness when it was not typed into the composer: `native-queue` is a
   * prompt Claude queued while busy and drained later, and `harness` is text the HARNESS wrote into the
   * user channel itself — a background-task notification, a subagent's or coordinator's message, a meta
   * record. A `harness` message is never something the owner said (`isOwnerMessage`). On an ASSISTANT
   * message, `harness` marks a record Claude Code wrote without any model speaking (`model: "<synthetic>"`).
   */
  readonly inputSource?: 'native-queue' | 'harness';
  readonly blockIndex?: number;
}

export interface TranscriptMessageEvent extends TranscriptEventMetadata {
  readonly kind: 'message';
  readonly text: string;
}

export interface TranscriptReasoningEvent extends TranscriptEventMetadata {
  readonly kind: 'reasoning';
  readonly text: string;
  readonly format: 'thinking' | 'reasoning';
}

export interface TranscriptToolCallEvent extends TranscriptEventMetadata {
  readonly kind: 'tool-call';
  readonly call: {
    readonly id: string;
    readonly name: string;
    readonly input: TranscriptJsonValue;
    readonly questions?: readonly TranscriptQuestion[];
  };
}

export interface TranscriptToolResultEvent extends TranscriptEventMetadata {
  readonly kind: 'tool-result';
  readonly result: {
    readonly callId: string;
    readonly content: TranscriptJsonValue;
    readonly text?: string;
    readonly isError: boolean;
  };
}

/**
 * Where a payload too large to hold sits in the transcript file: the bytes of a base64 string literal,
 * which are its value, since it holds no escape (`large-strings.ts`).
 */
export interface TranscriptBytesRef {
  readonly byteOffset: number;
  readonly byteLength: number;
}

export type TranscriptAttachment =
  | {
      readonly kind: 'image';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
      /** In place of `data` when the payload was too large to read into memory. */
      readonly dataRef?: TranscriptBytesRef;
    }
  | {
      readonly kind: 'audio';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
      /** In place of `data` when the payload was too large to read into memory. */
      readonly dataRef?: TranscriptBytesRef;
    }
  | {
      readonly kind: 'document';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
      /** In place of `data` when the payload was too large to read into memory. */
      readonly dataRef?: TranscriptBytesRef;
      readonly text?: string;
    }
  | {
      readonly kind: 'file';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
      /** In place of `data` when the payload was too large to read into memory. */
      readonly dataRef?: TranscriptBytesRef;
    }
  | {
      readonly kind: 'remote-control';
      readonly url: string;
    };

export interface TranscriptAttachmentEvent extends TranscriptEventMetadata {
  readonly kind: 'attachment';
  readonly attachment: TranscriptAttachment;
}

export interface TranscriptErrorEvent extends TranscriptEventMetadata {
  readonly kind: 'error';
  readonly error: {
    readonly message: string;
    readonly code?: string;
    readonly recoverable: boolean;
  };
}

export interface TranscriptUsageEvent extends TranscriptEventMetadata {
  readonly kind: 'usage';
  readonly usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    /**
     * The cache-write total split by retention, when the harness records it.
     *
     * Anthropic bills a 5-minute and a 1-hour cache write at DIFFERENT rates, so a total alone
     * cannot be turned into money. These are carried separately rather than folded into
     * `cacheCreationInputTokens` because a consumer that cannot see the split must be able to tell
     * that it is missing and decline to price, instead of charging every write at one guessed rate.
     */
    readonly cacheWrite5mInputTokens?: number;
    readonly cacheWrite1hInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly contextTokens?: number;
    readonly contextWindow?: number;
    readonly model?: string;
    /**
     * The harness's own running total for the whole session at this record, when it states one (Codex
     * `total_token_usage.total_tokens`). A record whose running total did not move reports no new
     * request, whatever its per-request figures say, so a reader summing usage skips it.
     */
    readonly sessionTotalTokens?: number;
  };
}

export interface TranscriptTurnEvent extends TranscriptEventMetadata {
  readonly kind: 'turn';
  readonly state: 'started' | 'completed' | 'aborted';
}

/** A harness-recorded context compaction boundary. Counts are the harness's own, when it states them. */
interface TranscriptCompactionEvent extends TranscriptEventMetadata {
  readonly kind: 'compaction';
  readonly trigger?: 'manual' | 'auto';
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
}

export interface TranscriptSettingsEvent extends TranscriptEventMetadata {
  readonly kind: 'settings';
  readonly settings: {
    readonly model?: string;
    readonly reasoningEffort?: string;
    /** The service tier the harness runs at, in its own words (Codex: `priority` is fast, `default` is not). */
    readonly serviceTier?: string;
  };
}

/** A normalized event shared by every harness parser. */
export type TranscriptEvent =
  | TranscriptMessageEvent
  | TranscriptReasoningEvent
  | TranscriptToolCallEvent
  | TranscriptToolResultEvent
  | TranscriptAttachmentEvent
  | TranscriptErrorEvent
  | TranscriptUsageEvent
  | TranscriptTurnEvent
  | TranscriptSettingsEvent
  | TranscriptCompactionEvent;

export type TranscriptIssueCode =
  | 'invalid-json'
  | 'incomplete-line'
  | 'truncated-json'
  | 'invalid-record'
  | 'invalid-tool-input'
  | 'unsupported-record'
  | 'source-missing'
  | 'source-read-failed'
  /** Bytes past the bounded read limit were deliberately not consumed. */
  | 'source-truncated'
  /** A single unterminated record outgrew the pending buffer and was discarded. */
  | 'oversized-record'
  | 'source-watch-failed';

/** A non-throwing note about data the parser or source could not consume. */
export interface TranscriptIssue {
  readonly harness: TranscriptHarness;
  readonly code: TranscriptIssueCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly source?: string;
  readonly line?: number;
  readonly recordType?: string;
  readonly itemType?: string;
  readonly blockType?: string;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

/**
 * How a human input was observed. The first two prove it ENTERED the conversation; the last two are
 * the harness's own queue bookkeeping — it is holding the text, or it let go of it — which proves
 * where a message is while it waits, and never that it was read.
 */
export type ObservedHumanInputProof =
  | 'normal-user-record'
  | 'native-queue-drain'
  | 'native-queue-hold'
  | 'native-queue-release';

/** Canonical evidence that human input entered the live harness conversation. */
export interface ObservedHumanInput {
  readonly harness: TranscriptHarness;
  readonly text: string;
  readonly proof: ObservedHumanInputProof;
  readonly observedAt: string;
  readonly originatedAt?: string;
  readonly proofKey: string;
  readonly shapeVersion: number;
}

interface TranscriptParseInputCommon {
  readonly source?: string;
  readonly sessionId?: string;
  /** Whether the final unterminated line is known to be the end of the input. */
  readonly endOfInput?: boolean;
  /** One-based line number assigned to the first line of the input. */
  readonly startLine?: number;
  /** Zero-based file byte offset assigned to the first byte of the input. */
  readonly startByteOffset?: number;
  /** Adapter-supplied read time used only when a proof record has no harness timestamp. */
  readonly observedAt?: string;
}

/**
 * What a parser reads: decoded text, or the exact bytes of a read.
 *
 * BYTES WIN WHEN BOTH ARE GIVEN. They are supplied so the parser — the one owner of where a physical
 * record starts and ends — can emit each record's exact byte slice from the same read, and it then
 * decodes each bounded record itself. A decoded string cannot stand in for them: re-encoding is only
 * lossless while the input was valid UTF-8, and evidence that changes meaning on a malformed byte is
 * evidence about the decoder rather than about the file. So a caller holding bytes passes only them:
 * decoding a whole read to `text` as well was a second full copy of up to 32 MiB the parser never looked
 * at, made in one synchronous call on the daemon's event loop.
 */
export type TranscriptParseInput = TranscriptParseInputCommon &
  ({ readonly text: string; readonly bytes?: Uint8Array } | { readonly text?: undefined; readonly bytes: Uint8Array });

/**
 * One complete physical record of a transcript file, exactly as it was read.
 *
 * `bytes` is the verbatim slice INCLUDING its line terminator when the file has one there, and
 * without inventing one for a final record that ends at end of file. A blank or unrecognised record
 * is still a record: it occupies the byte range, and evidence that skipped it would be evidence
 * about a file nobody has.
 */
export interface TranscriptRawRecord {
  /** Zero-based file byte offset of the record's first byte — the same coordinate an event carries. */
  readonly byteOffset: number;
  readonly bytes: Uint8Array;
}

export interface TranscriptRecordContext {
  readonly source?: string;
  readonly sessionId?: string;
  readonly line?: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

export interface TranscriptObservationContext extends TranscriptRecordContext {
  readonly observedAt?: string;
}

/** Stateful pure decision boundary for harness-specific human-input proof shapes. */
export interface TranscriptInputObserver {
  readonly harness: TranscriptHarness;
  observe(value: unknown, context: TranscriptObservationContext): readonly ObservedHumanInput[];
  reset(): void;
}

export interface TranscriptRecordResult {
  readonly events: readonly TranscriptEvent[];
  readonly issues: readonly TranscriptIssue[];
  readonly recognized: boolean;
}

export interface TranscriptParseResult {
  readonly harness: TranscriptHarness;
  readonly events: readonly TranscriptEvent[];
  readonly observedInputs: readonly ObservedHumanInput[];
  readonly issues: readonly TranscriptIssue[];
  /** Unterminated content retained for a later live-append parse. */
  readonly remainder: string;
  readonly parsedRecords: number;
  readonly ignoredRecords: number;
  /**
   * Every complete physical record consumed by this parse, in file order.
   *
   * Emitted exactly when the caller supplied `bytes`, because that is the only input from which an
   * exact slice can be taken. The parse that decides the boundaries is the one that reports them —
   * a second splitter downstream would be a second answer to "where does a record end".
   */
  readonly rawRecords?: readonly TranscriptRawRecord[];
}

/** Common parser contract: callers inject this interface and never branch by harness. */
export interface TranscriptParser {
  readonly harness: TranscriptHarness;
  parse(input: TranscriptParseInput, observer?: TranscriptInputObserver): TranscriptParseResult;
  parseRecord(value: unknown, context?: TranscriptRecordContext): TranscriptRecordResult;
  createInputObserver(): TranscriptInputObserver;
}

export interface TranscriptFileCursor {
  readonly identity?: string;
  readonly byteOffset: number;
  readonly pendingBytes: number;
  /**
   * The one-based line the next record starts on. Absent when the read began mid-file: counting the
   * lines before it would mean reading every byte the window exists to skip.
   */
  readonly nextLine?: number;
}

export interface TranscriptBatch {
  readonly harness: TranscriptHarness;
  readonly file: string;
  /** True when truncation or replacement caused the byte cursor to restart. */
  readonly reset: boolean;
  readonly cursor: TranscriptFileCursor;
  readonly events: readonly TranscriptEvent[];
  readonly observedInputs: readonly ObservedHumanInput[];
  readonly issues: readonly TranscriptIssue[];
  /**
   * Every complete physical record this batch was parsed from, carried from the SAME read.
   *
   * Present only when the source handed the parser the bytes its text was decoded from. A consumer
   * that needs record-exact evidence must refuse a batch without it rather than reconstruct one:
   * re-reading the file would answer about a later state of it, and re-splitting the normalized
   * events would answer about what the parser kept rather than about what the file holds.
   */
  readonly rawRecords?: readonly TranscriptRawRecord[];
}

export interface TranscriptReadOptions {
  readonly sessionId?: string;
}

export interface TranscriptFollowOptions extends TranscriptReadOptions {
  readonly pollIntervalMs?: number;
  readonly startAt?: 'beginning' | 'end';
  readonly signal?: AbortSignal;
}

/**
 * Where a window begins.
 *
 * `since` starts at a record boundary no later than the first record the harness stamped at or after
 * `instant`, found by scanning back from the END of the file — so what it costs is the bytes written
 * since then, never the file's size. `tail` starts on the first record boundary inside the last
 * `bytes` of the file, for a question about what is happening NOW. `beginning` reads the whole file,
 * one bounded step at a time.
 */
export type TranscriptWindowStart =
  | { readonly at: 'beginning' }
  | { readonly at: 'since'; readonly instant: string }
  | { readonly at: 'tail'; readonly bytes: number };

export interface TranscriptWindowOptions extends TranscriptReadOptions {
  readonly start: TranscriptWindowStart;
}

/** One bounded step of a window: the records appended since the last step, if any. */
export interface TranscriptWindowStep {
  readonly batch?: TranscriptBatch;
  /** True when the step stopped at its byte cap with bytes still unread, so another step is owed. */
  readonly more: boolean;
}

/**
 * An APPEND-ONLY, pull-based read of one file: it remembers its byte offset, and each step reads only
 * what was appended since — at most one bounded read's worth, with a partial last line carried until
 * its newline arrives. A replaced or truncated file restarts the window and says so (`batch.reset`).
 *
 * This is the read for a file that grows without limit. `read` answers "the whole conversation" and
 * must stop at a cap; a consumer that only needs what happened after some moment — did a send land,
 * what is the agent doing now — opens a window instead, and its cost is what was written since.
 */
export interface TranscriptWindow {
  readonly file: string;
  next(): Promise<TranscriptWindowStep>;
}

/** IO boundary implemented by transcript adapters. */
export interface TranscriptSource {
  readonly harness: TranscriptHarness;
  read(file: string, options?: TranscriptReadOptions): Promise<TranscriptBatch>;
  follow(file: string, options?: TranscriptFollowOptions): AsyncIterable<TranscriptBatch>;
  window(file: string, options: TranscriptWindowOptions): TranscriptWindow;
}
