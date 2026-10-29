import { basename, join } from 'node:path';
import {
  CONVERSATION_PREVIEW_MAX,
  type ConversationAdoptRefusalCode,
  type ConversationAdoptRequest,
  ConversationAdoptRequestSchema,
  type ConversationAdoptResult,
  type ConversationImportListing,
  type ConversationImportQuery,
  type ConversationPreview,
  type ConversationSource,
  type Harness,
  type ImportableConversation,
  ImportConversationIdSchema,
  type SessionStatus,
} from '@ferretry/protocol';
import type { PacedTranscriptParser, TranscriptEvent } from '../transcript/index.ts';
import { codexIndexNames, transcriptNames } from './conversation-name.ts';
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
 * Keeping an existing Claude Code / Codex conversation "on" as a ferret.
 *
 * DISCOVERY READS, IT NEVER WRITES. The file port below has no mutation method, so nothing this
 * module does can change a CLI's own files. A conversation is described from its own transcript
 * through the same parsers managed sessions use, and only metadata leaves: the folder, a truncated
 * preview, the last activity, the turn count and the model.
 *
 * ADOPTION NEVER COPIES. The adopter makes the SAME file visible inside the chosen runtime's history
 * (a hard link, see the adapter) and resumes it with the CLI's own resume path, so the transcript
 * Chat shows and the one the CLI appends to are one file.
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

/** One CLI home to look in: Ferretry's shared pool, or the owner's own (`~/.claude`, `~/.codex`). */
export interface ConversationRoot {
  readonly harness: Harness;
  readonly home: string;
  /** Which listing it belongs to: Ferretry's own history, or the computer's that importing reads. */
  readonly source: ConversationSource;
}

/** Which conversations a Ferretry session already keeps, keyed by {@link conversationKey}. */
export interface ConversationOwners {
  owners(): Promise<ReadonlyMap<string, string>>;
}

/**
 * Whether a `synced` listing includes the computer's own homes: the owner's "Keep in sync" switch
 * (Settings › Machine › Conversations). Asked fresh for every listing, so flipping it applies to the next
 * open of the list with no restart. It governs LISTING only: continuing a conversation the owner names
 * adopts it from wherever it is kept.
 */
export interface ConversationListPolicy {
  listsComputer(): Promise<boolean>;
}

/** The policy of a machine that never switched anything: the computer's conversations are listed. */
export const LIST_COMPUTER_CONVERSATIONS: ConversationListPolicy = { listsComputer: async () => true };

/** A conversation as the daemon knows it: the wire row plus where its file is. Never sent. */
export interface DiscoveredConversation extends Omit<ImportableConversation, 'adoptedBy'> {
  /** The transcript file. */
  readonly source: string;
  /** Its path below the CLI home (`projects/<folder>/<id>.jsonl`, `sessions/…/rollout-….jsonl`). */
  readonly relativePath: string;
}

export interface ConversationAdoption {
  readonly harness: Harness;
  readonly runtime: string;
  readonly conversation: DiscoveredConversation;
  readonly start: boolean;
}

export type ConversationAdoptionOutcome =
  | { readonly kind: 'adopted'; readonly session: string; readonly name: string; readonly status: SessionStatus }
  | { readonly kind: 'refused'; readonly code: ConversationAdoptRefusalCode; readonly reason: string };

/** Creates the ferret for one conversation. The composition root owns the session machinery. */
export interface ConversationAdopter {
  adopt(adoption: ConversationAdoption): Promise<ConversationAdoptionOutcome>;
}

export const conversationKey = (harness: Harness, id: string): string => `${harness}:${id}`;

/** The arguments that make each CLI continue a conversation it already has. */
export function conversationResumeArguments(harness: Harness, id: string): readonly string[] {
  return harness === 'claude' ? ['--resume', id] : ['resume', id];
}

/** Codex's thread-name index, in its home. Only its newest lines are read: it is append-only. */
const CODEX_INDEX = 'session_index.jsonl';
const CODEX_INDEX_READ_MAX_BYTES = 1024 * 1024;

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

const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
/** How deep Codex nests rollouts (`sessions/YYYY/MM/DD/`), plus one level of slack. */
const CODEX_MAX_DEPTH = 4;

interface Candidate {
  readonly harness: Harness;
  readonly source: string;
  readonly relativePath: string;
  /** The id the file name carries, when it carries one. */
  readonly nameId: string | undefined;
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

/**
 * The listing row a transcript describes, or why it describes none. Its preview and latest message are
 * what the owner said (`conversation-text.ts`), with each hand-off pointer read from `documents`. Its
 * name is the owner's, else the CLI's generated one unless that title describes the wrapper it was
 * generated from (a turn-file pointer, an AGENTS.md block) — then the first real message heads it.
 */
export function describeConversation(
  candidate: { readonly harness: Harness; readonly nameId: string | undefined },
  text: string,
  events: readonly TranscriptEvent[],
  modifiedAtMs: number,
  documents?: HandoffDocuments,
  /** The transcript's middle was not read, so the spoken messages counted are only some of them. */
  partial = false,
): Omit<DiscoveredConversation, 'source' | 'relativePath'> | undefined {
  const head = conversationHead(candidate.harness, text);
  if (head === undefined) return undefined;
  const { project } = head;
  const id = head.id ?? candidate.nameId;
  if (id === undefined || !ImportConversationIdSchema.safeParse(id).success) return undefined;
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

/** The search a listing applies: every word must appear somewhere, and the date is a floor. */
export function conversationMatcher(query: ConversationImportQuery): (row: DiscoveredConversation) => boolean {
  const words = (query.q ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');
  const since = query.since === undefined ? undefined : Date.parse(query.since);
  return row => {
    if (since !== undefined && Date.parse(row.lastActivityAt) < since) return false;
    const haystack = `${row.name ?? ''}\n${row.preview}\n${row.latest ?? ''}\n${row.project}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  };
}

interface CachedDescription {
  readonly modifiedAtMs: number;
  readonly size: number;
  readonly described: Omit<DiscoveredConversation, 'source' | 'relativePath'> | undefined;
}

/**
 * Lists, previews and adopts a machine's existing conversations.
 *
 * Each listing rescans, so a conversation the owner continued in their own terminal a minute ago is
 * current; a file whose size and modification time are unchanged is not re-parsed.
 */
export class ConversationImportService {
  private readonly cache = new Map<string, CachedDescription>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly files: ConversationFiles,
    /** In preference order: when two homes hold one conversation, the first one's file is used. */
    private readonly roots: readonly ConversationRoot[],
    /** Paced, because a conversation is read up to 8 MiB whole and would otherwise hold the loop through it. */
    private readonly parsers: Readonly<Record<Harness, PacedTranscriptParser>>,
    private readonly owners: ConversationOwners,
    private readonly adopter: ConversationAdopter,
    /** Where a hand-off pointer's document may be read from; a pointer anywhere else says nothing. */
    private readonly handoffScope: HandoffScope = NO_HANDOFF_SCOPE,
    private readonly policy: ConversationListPolicy = LIST_COMPUTER_CONVERSATIONS,
  ) {}

  async list(query: ConversationImportQuery = {}): Promise<ConversationImportListing> {
    const computerListed = query.source !== 'synced' || (await this.policy.listsComputer());
    const { conversations, skipped } = await this.discover(
      query.harness,
      query.source === 'synced' ? (computerListed ? undefined : 'ferretry') : query.source,
    );
    const owners = await this.owners.owners();
    const matching = conversations.filter(conversationMatcher(query));
    return {
      ...(computerListed ? {} : { computerListed: false as const }),
      matched: matching.length,
      conversations: matching
        .slice(0, query.limit ?? matching.length)
        .map(({ source: _source, relativePath: _relative, ...row }) => {
          const owner = owners.get(conversationKey(row.harness, row.id));
          return owner === undefined ? row : { ...row, adoptedBy: owner };
        }),
      skipped,
    };
  }

  /**
   * The last few exchanges of one conversation, cleaned like the listing, or `undefined` when no home
   * holds it. Read fresh: it is asked for one row at a time, just before the owner continues it.
   */
  async preview(harness: Harness, id: string): Promise<ConversationPreview | undefined> {
    const { conversations } = await this.discover(harness);
    const conversation = conversations.find(row => row.id === id);
    if (conversation === undefined) return undefined;
    const info = await this.files.info(conversation.source);
    const read = info === undefined ? undefined : await boundedTranscript(this.files, conversation.source, info.size);
    if (read === undefined) return undefined;
    const { events } = await this.parsers[harness].parse({
      text: read.text,
      source: conversation.source,
      endOfInput: true,
    });
    return { id, harness, messages: [...recentExchanges(events, await this.handoffDocuments(events))] };
  }

  /** One adoption at a time, so two pickers can never both keep one conversation. */
  async adopt(request: ConversationAdoptRequest): Promise<ConversationAdoptResult> {
    const parsed = ConversationAdoptRequestSchema.parse(request);
    const run = this.serial.then(async () => await this.adoptNow(parsed));
    this.serial = run.catch(() => undefined);
    return await run;
  }

  private async adoptNow(
    request: ReturnType<typeof ConversationAdoptRequestSchema.parse>,
  ): Promise<ConversationAdoptResult> {
    const { conversations } = await this.discover(request.harness);
    const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
    const owners = new Map(await this.owners.owners());
    const result: { adopted: ConversationAdoptResult['adopted']; refused: ConversationAdoptResult['refused'] } = {
      adopted: [],
      refused: [],
    };
    for (const item of request.conversations) {
      const conversation = byId.get(item.id);
      if (conversation === undefined) {
        result.refused.push({
          id: item.id,
          code: 'not_found',
          reason: `No ${request.harness === 'claude' ? 'Claude Code' : 'Codex'} conversation ${item.id} is on this machine.`,
        });
        continue;
      }
      const owner = owners.get(conversationKey(request.harness, item.id));
      if (owner !== undefined) {
        result.refused.push({ id: item.id, code: 'already_adopted', reason: `Session ${owner} already keeps it.` });
        continue;
      }
      const outcome = await this.adopter
        .adopt({ harness: request.harness, runtime: request.runtime, conversation, start: item.start })
        .catch(
          (error: unknown): ConversationAdoptionOutcome => ({
            kind: 'refused',
            code: 'failed',
            reason: error instanceof Error && error.message !== '' ? error.message : 'The ferret could not be created.',
          }),
        );
      if (outcome.kind === 'refused') {
        result.refused.push({ id: item.id, code: outcome.code, reason: outcome.reason });
        continue;
      }
      owners.set(conversationKey(request.harness, item.id), outcome.session);
      result.adopted.push({ id: item.id, session: outcome.session, name: outcome.name, status: outcome.status });
    }
    return result;
  }

  private async discover(
    harness: Harness | undefined,
    source?: ConversationSource,
  ): Promise<{ readonly conversations: readonly DiscoveredConversation[]; readonly skipped: number }> {
    const seen = new Map<string, DiscoveredConversation>();
    let skipped = 0;
    for (const root of this.roots) {
      if (harness !== undefined && root.harness !== harness) continue;
      if (source !== undefined && root.source !== source) continue;
      const index = await this.indexNames(root);
      for (const candidate of await this.candidates(root)) {
        const described = await this.describe(candidate);
        if (described === undefined) {
          skipped += 1;
          continue;
        }
        const key = conversationKey(described.harness, described.id);
        const indexed = index.get(described.id);
        if (!seen.has(key))
          seen.set(key, {
            ...described,
            ...(indexed === undefined ? {} : { name: indexed }),
            keptIn: root.source,
            source: candidate.source,
            relativePath: candidate.relativePath,
          });
      }
    }
    const conversations = [...seen.values()].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
    return { conversations, skipped };
  }

  /** Codex's own name for each thread, which wins over the one a rollout recorded: it is what `resume` reads. */
  private async indexNames(root: ConversationRoot): Promise<ReadonlyMap<string, string>> {
    if (root.harness !== 'codex') return new Map();
    const text = await this.files.tail(join(root.home, CODEX_INDEX), CODEX_INDEX_READ_MAX_BYTES);
    return text === undefined ? new Map() : codexIndexNames(text);
  }

  private async describe(
    candidate: Candidate,
  ): Promise<Omit<DiscoveredConversation, 'source' | 'relativePath'> | undefined> {
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

  /**
   * Claude keeps `projects/<folder>/<id>.jsonl` (a subfolder there holds a conversation's sub-agents,
   * which are not conversations an owner had). Codex keeps `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
   */
  private async candidates(root: ConversationRoot): Promise<readonly Candidate[]> {
    if (root.harness === 'claude') {
      const found: Candidate[] = [];
      for (const project of await this.files.entries(join(root.home, 'projects'))) {
        if (project.kind !== 'directory') continue;
        for (const entry of await this.files.entries(join(root.home, 'projects', project.name))) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
          found.push({
            harness: 'claude',
            source: join(root.home, 'projects', project.name, entry.name),
            relativePath: join('projects', project.name, entry.name),
            nameId: basename(entry.name, '.jsonl'),
          });
        }
      }
      return found;
    }
    const found: Candidate[] = [];
    const pending: { readonly relative: string; readonly depth: number }[] = [{ relative: 'sessions', depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const entry of await this.files.entries(join(root.home, next.relative))) {
        const relative = join(next.relative, entry.name);
        if (entry.kind === 'directory' && next.depth < CODEX_MAX_DEPTH)
          pending.push({ relative, depth: next.depth + 1 });
        else if (entry.kind === 'file' && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
          found.push({
            harness: 'codex',
            source: join(root.home, relative),
            relativePath: relative,
            nameId: ROLLOUT_ID.exec(entry.name)?.[1],
          });
      }
    }
    return found;
  }
}
