/**
 * THE PART OF A FERRET'S TRANSCRIPT THE BOARD READS: its last turn's tool calls (the turn-end check, the `gh pr create`
 * a ferret ran). A structural subset of the Conversation plugin's transcript events: the adapter hands over whatever
 * carries these fields, and Board imports nothing from Conversation.
 */

/** JSON data retained from a harness record. */
export type TranscriptJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly TranscriptJsonValue[]
  | { readonly [key: string]: TranscriptJsonValue };

interface EventBase {
  readonly role: 'user' | 'assistant' | 'developer' | 'system' | 'tool';
  readonly timestamp?: string;
  /** `harness` is text the harness wrote into the user channel itself: never something the owner said. */
  readonly inputSource?: 'native-queue' | 'harness';
}

export interface TranscriptMessageEvent extends EventBase {
  readonly kind: 'message';
  readonly text: string;
}

export interface TranscriptToolCallEvent extends EventBase {
  readonly kind: 'tool-call';
  readonly call: { readonly id: string; readonly name: string; readonly input: TranscriptJsonValue };
}

export interface TranscriptToolResultEvent extends EventBase {
  readonly kind: 'tool-result';
  readonly result: {
    readonly callId: string;
    readonly content: TranscriptJsonValue;
    readonly text?: string;
    readonly isError: boolean;
  };
}

/** Any other event kind (reasoning, attachments, …): read by nobody here. */
export interface TranscriptOtherEvent extends EventBase {
  readonly kind: 'reasoning' | 'attachment' | 'question' | 'status';
}

export type TranscriptEvent =
  | TranscriptMessageEvent
  | TranscriptToolCallEvent
  | TranscriptToolResultEvent
  | TranscriptOtherEvent;

/** A transcript read that reports whether the file was RESOLVED, separately from what it contained. */
export type TranscriptTailResult =
  /** The daemon cannot prove which transcript file belongs to this ferret. */
  | { readonly kind: 'unresolved' }
  /** The exact file was proved, but it disappeared or could not be parsed when it was read. */
  | { readonly kind: 'unreadable' }
  /** A file was resolved and read. `events` may legitimately be empty — the ferret has not spoken yet. */
  | { readonly kind: 'read'; readonly events: readonly TranscriptEvent[] };

/** The newest events of a ferret's transcript: Conversation's read, through the adapter. */
export interface FerretTranscriptTail {
  tail(ferret: string, limit: number): Promise<TranscriptTailResult>;
}
