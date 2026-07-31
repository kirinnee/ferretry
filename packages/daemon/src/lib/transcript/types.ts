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

export type TranscriptAttachment =
  | {
      readonly kind: 'queued-command';
      readonly text: string;
      readonly origin: 'human';
    }
  | {
      readonly kind: 'image';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
    }
  | {
      readonly kind: 'audio';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
    }
  | {
      readonly kind: 'document';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
      readonly text?: string;
    }
  | {
      readonly kind: 'file';
      readonly name?: string;
      readonly mediaType?: string;
      readonly uri?: string;
      readonly data?: string;
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
    readonly reasoningTokens?: number;
    readonly contextTokens?: number;
    readonly contextWindow?: number;
    readonly model?: string;
  };
}

export interface TranscriptTurnEvent extends TranscriptEventMetadata {
  readonly kind: 'turn';
  readonly state: 'started' | 'completed' | 'aborted';
}

export interface TranscriptSettingsEvent extends TranscriptEventMetadata {
  readonly kind: 'settings';
  readonly settings: {
    readonly model?: string;
    readonly reasoningEffort?: string;
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
  | TranscriptSettingsEvent;

export type TranscriptIssueCode =
  | 'invalid-json'
  | 'incomplete-line'
  | 'truncated-json'
  | 'invalid-record'
  | 'invalid-tool-input'
  | 'unsupported-record'
  | 'source-missing'
  | 'source-read-failed'
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
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

export interface TranscriptParseInput {
  readonly text: string;
  readonly source?: string;
  readonly sessionId?: string;
  /** Whether the final unterminated line is known to be the end of the input. */
  readonly endOfInput?: boolean;
  /** One-based line number assigned to the first line in `text`. */
  readonly startLine?: number;
  /** Zero-based file byte offset assigned to the first byte in `text`. */
  readonly startByteOffset?: number;
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

export interface TranscriptParseResult {
  readonly harness: TranscriptHarness;
  readonly events: readonly TranscriptEvent[];
  readonly issues: readonly TranscriptIssue[];
  /** Unterminated content retained for a later live-append parse. */
  readonly remainder: string;
  readonly parsedRecords: number;
  readonly ignoredRecords: number;
}

/** Common parser contract: callers inject this interface and never branch by harness. */
export interface TranscriptParser {
  readonly harness: TranscriptHarness;
  parse(input: TranscriptParseInput): TranscriptParseResult;
  parseRecord(value: unknown, context?: TranscriptRecordContext): TranscriptRecordResult;
}

export interface TranscriptFileCursor {
  readonly identity?: string;
  readonly byteOffset: number;
  readonly pendingBytes: number;
  readonly nextLine: number;
}

export interface TranscriptBatch {
  readonly harness: TranscriptHarness;
  readonly file: string;
  /** True when truncation or replacement caused the byte cursor to restart. */
  readonly reset: boolean;
  readonly cursor: TranscriptFileCursor;
  readonly events: readonly TranscriptEvent[];
  readonly issues: readonly TranscriptIssue[];
}

export interface TranscriptReadOptions {
  readonly sessionId?: string;
}

export interface TranscriptFollowOptions extends TranscriptReadOptions {
  readonly pollIntervalMs?: number;
  readonly startAt?: 'beginning' | 'end';
  readonly signal?: AbortSignal;
}

/** IO boundary implemented by transcript adapters. */
export interface TranscriptSource {
  readonly harness: TranscriptHarness;
  read(file: string, options?: TranscriptReadOptions): Promise<TranscriptBatch>;
  follow(file: string, options?: TranscriptFollowOptions): AsyncIterable<TranscriptBatch>;
}
