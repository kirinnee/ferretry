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

interface TranscriptQuestionOption {
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

interface TranscriptMessageEvent extends TranscriptEventMetadata {
  readonly kind: 'message';
  readonly text: string;
}

interface TranscriptReasoningEvent extends TranscriptEventMetadata {
  readonly kind: 'reasoning';
  readonly text: string;
  readonly format: 'thinking' | 'reasoning';
}

interface TranscriptToolCallEvent extends TranscriptEventMetadata {
  readonly kind: 'tool-call';
  readonly call: {
    readonly id: string;
    readonly name: string;
    readonly input: TranscriptJsonValue;
    readonly questions?: readonly TranscriptQuestion[];
  };
}

interface TranscriptToolResultEvent extends TranscriptEventMetadata {
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
interface TranscriptBytesRef {
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

interface TranscriptAttachmentEvent extends TranscriptEventMetadata {
  readonly kind: 'attachment';
  readonly attachment: TranscriptAttachment;
}

interface TranscriptErrorEvent extends TranscriptEventMetadata {
  readonly kind: 'error';
  readonly error: {
    readonly message: string;
    readonly code?: string;
    readonly recoverable: boolean;
  };
}

interface TranscriptUsageEvent extends TranscriptEventMetadata {
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

interface TranscriptTurnEvent extends TranscriptEventMetadata {
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

interface TranscriptSettingsEvent extends TranscriptEventMetadata {
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
  /**
   * Bytes past the bounded read limit were deliberately not consumed. From a window or a follower this is
   * ordinary paging — the next step reads on from there — and a reader that reached the end missed nothing.
   */
  | 'source-truncated'
  /**
   * A `since` window could not reach back to the instant it was asked for: the file is longer behind that
   * instant than a window may reach, so it starts later, and what came before its start was never read.
   */
  | 'window-capped'
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

export interface TranscriptRecordContext {
  readonly source?: string;
  readonly sessionId?: string;
  readonly line?: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

export interface TranscriptRecordResult {
  readonly events: readonly TranscriptEvent[];
  readonly issues: readonly TranscriptIssue[];
  readonly recognized: boolean;
}
