import { createHash } from 'node:crypto';
import type { FerretId, TranscriptEntry, TranscriptReader } from '@ferretry/core-ferrets/contract';
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
import { portableConversationRows } from '../lib/session/digest.ts';
import type { TranscriptProvenance } from '../lib/session/protocol.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptRawRecord,
  TranscriptRole,
} from '../lib/transcript/types.ts';

/** The ferret's transcript as its harness plugin's `TranscriptReader` reads it; absent when the ferret is not known. */
export interface HarnessTranscript {
  readonly harness: TranscriptHarness;
  readonly reader: TranscriptReader;
}

export type HarnessTranscripts = (ferret: FerretId) => Promise<HarnessTranscript | undefined>;

/** The most entries one read pulls from a harness reader: the reader pages, this walks until the end. */
const ENTRY_PAGE = 1_000;
/** A conversation longer than this is refused as unreadable, never served as a shorter one (lost history is not a prefix). */
export const MAX_ENTRIES = 200_000;

const ROLES: Readonly<Record<TranscriptEntry['role'], TranscriptRole>> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  system: 'system',
};

/** One entry as the bytes its row is committed over: the facts of the entry, in a fixed order, one line. */
const recordBytes = (entry: TranscriptEntry): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify({ id: entry.id, at: entry.at, role: entry.role, text: entry.text ?? null, data: entry.data ?? null })}\n`,
  );

/** The entry as one event, carrying the byte coordinate of its record in the reader's own stream. */
const eventOf = (
  harness: TranscriptHarness,
  entry: TranscriptEntry,
  byteOffset: number,
  byteLength: number,
): TranscriptEvent => {
  const base = {
    harness,
    role: ROLES[entry.role],
    timestamp: entry.at,
    recordId: entry.id,
    byteOffset,
    byteLength,
    blockIndex: 0,
  } as const;
  if (entry.role === 'tool')
    return {
      ...base,
      kind: 'tool-result',
      result: { callId: entry.id, content: entry.data ?? entry.text ?? null, isError: false, text: entry.text ?? '' },
    } as TranscriptEvent;
  return { ...base, kind: 'message', text: entry.text ?? '' } as TranscriptEvent;
};

/**
 * One whole read of a ferret's conversation: every entry, as events and as the records their rows are committed over.
 * The stream is the harness reader's, so a byte offset here names a place in THAT stream: stable while the reader's
 * entries are, and different once an earlier entry changed (which is what a stale cursor is).
 */
interface Whole {
  readonly harness: TranscriptHarness;
  readonly events: readonly TranscriptEvent[];
  readonly records: readonly TranscriptRawRecord[];
  readonly entries: readonly TranscriptEntry[];
  /** An opaque token naming this conversation, never a path: the first entry's identity. */
  readonly file: string;
}

async function readWhole(ferret: FerretId, transcript: HarnessTranscript): Promise<Whole | 'unreadable'> {
  const entries: TranscriptEntry[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await transcript.reader.read(ferret, after, ENTRY_PAGE);
    entries.push(...page);
    if (page.length < ENTRY_PAGE) break;
    if (entries.length > MAX_ENTRIES) return 'unreadable';
    after = page[page.length - 1]?.id;
  }
  let offset = 0;
  const events: TranscriptEvent[] = [];
  const records: TranscriptRawRecord[] = [];
  for (const entry of entries) {
    const bytes = recordBytes(entry);
    records.push({ byteOffset: offset, bytes });
    events.push(eventOf(transcript.harness, entry, offset, bytes.byteLength));
    offset += bytes.byteLength;
  }
  const first = entries[0];
  const file = createHash('sha256')
    .update(`${ferret}\u0000${first?.id ?? ''}`)
    .digest('base64url')
    .slice(0, 22);
  return { harness: transcript.harness, events, records, entries, file };
}

/** The reads over the harness plugin's `TranscriptReader`: today's `TranscriptSource` files, as entries. */
export class EntriesTranscriptSource
  implements SessionTranscriptTail, SessionTranscriptPages, SessionTranscriptSearch, MessageRowSource
{
  constructor(private readonly transcripts: HarnessTranscripts) {}

  async #whole(ferret: string): Promise<Whole | 'unresolved' | 'unreadable'> {
    const transcript = await this.transcripts(ferret as FerretId);
    if (transcript === undefined) return 'unresolved';
    return await readWhole(ferret as FerretId, transcript).catch((): 'unreadable' => 'unreadable');
  }

  async tail(sessionId: string, limit: number): Promise<TranscriptTailResult> {
    const whole = await this.#whole(sessionId);
    if (typeof whole === 'string') return { kind: whole };
    return { kind: 'read', events: whole.events.slice(-limit) };
  }

  async page(
    sessionId: string,
    query: { readonly before?: number; readonly from?: number; readonly limit: number },
  ): Promise<TranscriptPageResult> {
    const whole = await this.#whole(sessionId);
    if (typeof whole === 'string') return { kind: whole };
    const eligible = whole.events.filter(
      event =>
        (query.before === undefined || (event.byteOffset ?? 0) < query.before) &&
        (query.from === undefined || (event.byteOffset ?? 0) >= query.from),
    );
    const events = eligible.slice(-query.limit);
    const start = events[0]?.byteOffset ?? query.before ?? 0;
    return { kind: 'read', events, start, file: whole.file };
  }

  // read-scoped: none — returns raw events to the reads service, which masks every snippet through the read-scoped redactor
  async search(
    sessionId: string,
    query: {
      readonly needle: string | undefined;
      readonly accept: (event: TranscriptEvent) => boolean;
      readonly limit: number;
    },
  ): Promise<TranscriptSearchReadResult> {
    const whole = await this.#whole(sessionId);
    if (typeof whole === 'string') return { kind: whole };
    const found: TranscriptEvent[] = [];
    let truncated = false;
    for (let index = whole.events.length - 1; index >= 0; index -= 1) {
      const event = whole.events[index] as TranscriptEvent;
      // The raw needle is the cheap prefilter; `accept` (which may scrub) only runs on what it let through.
      if (query.needle !== undefined && !JSON.stringify(event).toLowerCase().includes(query.needle)) continue;
      if (!query.accept(event)) continue;
      if (found.length >= query.limit) {
        truncated = true;
        break;
      }
      found.push(event);
    }
    return { kind: 'read', events: found.reverse(), truncated, file: whole.file };
  }

  async read(sessionId: string): Promise<MessageRowReadResult> {
    const whole = await this.#whole(sessionId);
    if (typeof whole === 'string') return whole === 'unresolved' ? { kind: 'unresolved' } : { kind: 'unreadable' };
    const batch: TranscriptBatch = {
      harness: whole.harness,
      file: whole.file,
      reset: false,
      cursor: { byteOffset: whole.records.reduce((sum, record) => sum + record.bytes.byteLength, 0), pendingBytes: 0 },
      events: whole.events,
      observedInputs: [],
      issues: [],
      rawRecords: whole.records,
    };
    const rows = portableConversationRows(sessionId, batch);
    const provenance: TranscriptProvenance = {
      v: 1,
      home: whole.harness,
      identity: 'minted',
      harnessSessionId: sessionId,
      file: whole.file,
      ...(whole.entries[0] === undefined ? {} : { resolvedAt: whole.entries[0].at }),
    };
    return { kind: 'read', context: { sessionId, incarnation: whole.file, provenance }, rows };
  }
}
