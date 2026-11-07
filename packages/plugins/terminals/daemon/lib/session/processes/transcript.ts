/**
 * The transcript events the Processes tab reads (today's `lib/transcript/types.ts`, the shapes `transcript-evidence.ts`
 * looks at: shell tool calls, their results and messages). Any other event is passed over.
 */
export type TranscriptJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly TranscriptJsonValue[]
  | { readonly [key: string]: TranscriptJsonValue };

interface TranscriptEventMetadata {
  /** Which harness wrote it and in what voice (today's metadata); the evidence reads neither. */
  readonly harness?: string;
  readonly role?: string;
  readonly timestamp?: string;
}

export type TranscriptEvent =
  | (TranscriptEventMetadata & { readonly kind: 'message'; readonly text: string })
  | (TranscriptEventMetadata & {
      readonly kind: 'tool-call';
      readonly call: { readonly id: string; readonly name: string; readonly input: TranscriptJsonValue };
    })
  | (TranscriptEventMetadata & {
      readonly kind: 'tool-result';
      readonly result: {
        readonly callId: string;
        readonly content: TranscriptJsonValue;
        readonly text?: string;
        readonly isError: boolean;
      };
    })
  | (TranscriptEventMetadata & { readonly kind: 'other' });

/** Today's `TranscriptTailResult`. */
export type TranscriptTailResult =
  /** The daemon cannot prove which transcript file belongs to this ferret. */
  | { readonly kind: 'unresolved' }
  /** The exact file was proved, but it disappeared or could not be parsed when it was read. */
  | { readonly kind: 'unreadable' }
  /** A file was resolved and read. `events` may legitimately be empty — the agent has not spoken yet. */
  | { readonly kind: 'read'; readonly events: readonly TranscriptEvent[] };
