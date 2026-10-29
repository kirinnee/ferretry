import {
  CONVERSATION_PREVIEW_MAX,
  type ConversationPreview,
  type ImportableConversation,
  ImportConversationIdSchema,
} from '@ferretry/protocol/conversation-import';
import type { Harness } from '@ferretry/protocol/session-base';
import type { PacedTranscriptParser } from '../transcript/sliced.ts';
import type { TranscriptEvent } from '../transcript/types.ts';
import { transcriptNames } from './conversation-name.ts';
import {
  HANDOFF_READ_MAX_BYTES,
  type HandoffDocuments,
  type HandoffScope,
  handoffPointers,
  isReadableHandoff,
  isWrapperTitle,
  NO_HANDOFF_SCOPE,
  recentExchanges,
  spokenMessages,
  wrapperOnlyWords,
} from './conversation-text.ts';

/**
 * WHAT ONE CONVERSATION FILE SAYS ABOUT ITSELF: read, parsed and described, wherever that runs.
 *
 * A listing reads up to 8 MiB of every transcript a person has and parses each one, and a preview does
 * the same for one more. That is work the transcript parse worker can do instead of the event loop, so
 * it is a port: {@link ConversationDescriber} answers from plain data (a candidate in, a row out) and
 * {@link FileConversationDescriber} is the reader that does it — on this thread, or inside the worker,
 * which loads this module and so imports only what it needs.
 */

/** A directory entry as discovery needs it. A link is `other`: discovery never follows one. */
export interface ConversationFileEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

export interface ConversationFileInfo {
  readonly modifiedAtMs: number;
  readonly size: number;
}

/** Read-only by construction: there is no way to write through this port. */
export interface ConversationFiles {
  entries(directory: string): Promise<readonly ConversationFileEntry[]>;
  info(file: string): Promise<ConversationFileInfo | undefined>;
  /** At most the last `maxBytes` of a file: where an append-only index keeps its newest lines. */
  tail(file: string, maxBytes: number): Promise<string | undefined>;
  /** At most the first `maxBytes` of a file, for documents that are not trusted to be small. */
  head(file: string, maxBytes: number): Promise<string | undefined>;
}

/** One transcript file a listing found: which harness wrote it, where, and the id its name carries. Plain data. */
export interface ConversationCandidate {
  readonly harness: Harness;
  readonly source: string;
  /** Its path below the CLI home (`projects/<folder>/<id>.jsonl`, `sessions/…/rollout-….jsonl`). */
  readonly relativePath: string;
  /** The id the file name carries, when it carries one. */
  readonly nameId?: string | undefined;
}

/** The listing row a transcript describes, before the listing adds where it was kept. */
export type DescribedConversation = Omit<ImportableConversation, 'adoptedBy'>;

/** Describes the conversation one transcript holds; where its read and parse run is the adapter's choice. */
export interface ConversationDescriber {
  /** The row `candidate` describes, or `undefined` when its file is gone or describes no conversation. */
  describe(candidate: ConversationCandidate): Promise<DescribedConversation | undefined>;
  /**
   * The last few exchanges of the conversation `candidate` is, cleaned like the listing, with each
   * hand-off document read where the scope allows it; `undefined` when the file cannot be read or says
   * no conversation. Read fresh: it is asked for one row at a time, just before the owner continues it.
   */
  preview(candidate: ConversationCandidate): Promise<ConversationPreview | undefined>;
}

/**
 * How much of a transcript a listing reads from each END.
 *
 * Everything a row says is at one end or the other — the folder and the first message at the start,
 * the latest message, the model and the last activity at the end — and a transcript grows without
 * limit: an adopted conversation reached 200 MB, and reading it whole for every listing held all of
 * it in memory, twice, because the same file is listed from two homes. A file larger than both ends
 * together is described from them alone, and says its turn count is only a floor.
 */
export const CONVERSATION_HEAD_READ_MAX_BYTES = 4 * 1024 * 1024;
export const CONVERSATION_TAIL_READ_MAX_BYTES = 4 * 1024 * 1024;

/** A transcript as a listing may read it: whole when small, else its first and last complete records. */
interface BoundedTranscript {
  readonly text: string;
  /** The middle was not read. */
  readonly partial: boolean;
}

async function boundedTranscript(
  files: ConversationFiles,
  file: string,
  size: number,
): Promise<BoundedTranscript | undefined> {
  if (size <= CONVERSATION_HEAD_READ_MAX_BYTES + CONVERSATION_TAIL_READ_MAX_BYTES) {
    const text = await files.head(file, size);
    return text === undefined ? undefined : { text, partial: false };
  }
  const [head, tail] = await Promise.all([
    files.head(file, CONVERSATION_HEAD_READ_MAX_BYTES),
    files.tail(file, CONVERSATION_TAIL_READ_MAX_BYTES),
  ]);
  if (head === undefined || tail === undefined) return undefined;
  // Each end is cut to whole records: the head's last line and the tail's first are pieces of ones
  // the read cut through, and a piece parsed as a record is a record nobody wrote.
  const start = tail.indexOf('\n');
  return {
    text: `${head.slice(0, head.lastIndexOf('\n') + 1)}${start < 0 ? '' : tail.slice(start + 1)}`,
    partial: true,
  };
}

/**
 * The working folder a transcript records — Claude on every record, Codex in its `session_meta` — and,
 * for Codex, the conversation id that record carries (Claude names a conversation by its file).
 */
export function conversationHead(
  harness: Harness,
  text: string,
): { readonly project: string; readonly id: string | undefined } | undefined {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const holder =
      harness === 'claude'
        ? record
        : record.type === 'session_meta' && typeof record.payload === 'object' && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : undefined;
    const cwd = holder?.cwd;
    if (typeof cwd === 'string' && cwd.startsWith('/'))
      return { project: cwd, id: typeof holder?.id === 'string' && harness === 'codex' ? holder.id : undefined };
  }
  return undefined;
}

/** The id a conversation goes by — the one its record carries, else its file name's — when it is a usable one. */
function conversationIdOf(
  candidate: { readonly nameId?: string | undefined },
  head: { readonly id: string | undefined },
): string | undefined {
  const id = head.id ?? candidate.nameId;
  return id === undefined || !ImportConversationIdSchema.safeParse(id).success ? undefined : id;
}

/**
 * The listing row a transcript describes, or why it describes none. Its preview and latest message are
 * what the owner said (`conversation-text.ts`), with each hand-off pointer read from `documents`. Its
 * name is the owner's, else the CLI's generated one unless that title describes the wrapper it was
 * generated from (a turn-file pointer, an AGENTS.md block) — then the first real message heads it.
 */
export function describeConversation(
  candidate: { readonly harness: Harness; readonly nameId?: string | undefined },
  text: string,
  events: readonly TranscriptEvent[],
  modifiedAtMs: number,
  documents?: HandoffDocuments,
  /** The transcript's middle was not read, so the spoken messages counted are only some of them. */
  partial = false,
): DescribedConversation | undefined {
  const head = conversationHead(candidate.harness, text);
  if (head === undefined) return undefined;
  const { project } = head;
  const id = conversationIdOf(candidate, head);
  if (id === undefined) return undefined;
  const spoken = spokenMessages(events, documents);
  const first = spoken[0];
  if (first === undefined) return undefined;
  const names = transcriptNames(candidate.harness, text);
  const generated =
    names.generated === undefined || isWrapperTitle(names.generated, wrapperOnlyWords(events, documents))
      ? undefined
      : names.generated;
  const name = names.chosen ?? generated;
  const latest = spoken.at(-1);
  let model: string | undefined;
  let last: string | undefined;
  for (const event of events) {
    if (event.kind === 'usage' && event.usage.model !== undefined) model = event.usage.model;
    if (event.kind === 'settings' && event.settings.model !== undefined) model = event.settings.model;
    if (event.timestamp !== undefined && (last === undefined || Date.parse(event.timestamp) > Date.parse(last)))
      last = event.timestamp;
  }
  const parsedLast = last === undefined ? Number.NaN : Date.parse(last);
  return {
    id,
    harness: candidate.harness,
    project,
    ...(name === undefined ? {} : { name }),
    preview: first.slice(0, CONVERSATION_PREVIEW_MAX),
    ...(latest === undefined || latest === first ? {} : { latest: latest.slice(0, CONVERSATION_PREVIEW_MAX) }),
    lastActivityAt: new Date(Number.isNaN(parsedLast) ? modifiedAtMs : parsedLast).toISOString(),
    turns: spoken.length,
    ...(partial ? { turnsAtLeast: true as const } : {}),
    ...(model === undefined ? {} : { model }),
  };
}

interface CachedDescription {
  readonly modifiedAtMs: number;
  readonly size: number;
  readonly described: DescribedConversation | undefined;
}

/**
 * Describes conversations from their files: the bounded read, the parse, the row.
 *
 * A file whose size and modification time are unchanged is not re-parsed, so the cache lives with the
 * reader that parses — a listing that runs in the worker is remembered in the worker.
 */
export class FileConversationDescriber implements ConversationDescriber {
  private readonly cache = new Map<string, CachedDescription>();

  constructor(
    private readonly files: ConversationFiles,
    /** Paced, because a conversation is read up to 8 MiB whole and would otherwise hold the loop through it. */
    private readonly parsers: Readonly<Record<Harness, PacedTranscriptParser>>,
    /** Where a hand-off pointer's document may be read from; a pointer anywhere else says nothing. */
    private readonly handoffScope: HandoffScope = NO_HANDOFF_SCOPE,
  ) {}

  async describe(candidate: ConversationCandidate): Promise<DescribedConversation | undefined> {
    const info = await this.files.info(candidate.source);
    if (info === undefined) return undefined;
    const cached = this.cache.get(candidate.source);
    if (cached !== undefined && cached.modifiedAtMs === info.modifiedAtMs && cached.size === info.size)
      return cached.described;
    const read = await boundedTranscript(this.files, candidate.source, info.size);
    // A live conversation may end mid-record; the complete records before it still describe it.
    const events =
      read === undefined
        ? undefined
        : (await this.parsers[candidate.harness].parse({ text: read.text, source: candidate.source, endOfInput: true }))
            .events;
    const described =
      read === undefined || events === undefined
        ? undefined
        : describeConversation(
            candidate,
            read.text,
            events,
            info.modifiedAtMs,
            await this.handoffDocuments(events),
            read.partial,
          );
    this.cache.set(candidate.source, { modifiedAtMs: info.modifiedAtMs, size: info.size, described });
    return described;
  }

  async preview(candidate: ConversationCandidate): Promise<ConversationPreview | undefined> {
    const info = await this.files.info(candidate.source);
    const read = info === undefined ? undefined : await boundedTranscript(this.files, candidate.source, info.size);
    if (read === undefined) return undefined;
    const head = conversationHead(candidate.harness, read.text);
    const id = head === undefined ? undefined : conversationIdOf(candidate, head);
    if (id === undefined) return undefined;
    const { events } = await this.parsers[candidate.harness].parse({
      text: read.text,
      source: candidate.source,
      endOfInput: true,
    });
    return {
      id,
      harness: candidate.harness,
      messages: [...recentExchanges(events, await this.handoffDocuments(events))],
    };
  }

  /**
   * The hand-off documents `events` point at, each read only where the hand-off scope allows it and
   * only up to {@link HANDOFF_READ_MAX_BYTES}. One that cannot be read is left out, which makes its
   * pointer say nothing.
   */
  private async handoffDocuments(events: readonly TranscriptEvent[]): Promise<HandoffDocuments> {
    const documents = new Map<string, string>();
    for (const path of handoffPointers(events)) {
      if (!isReadableHandoff(path, this.handoffScope)) continue;
      const document = await this.files.head(path, HANDOFF_READ_MAX_BYTES);
      if (document !== undefined) documents.set(path, document);
    }
    return documents;
  }
}
