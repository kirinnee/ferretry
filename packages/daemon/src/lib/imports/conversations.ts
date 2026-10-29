import { basename, join } from 'node:path';
import {
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
  type SessionStatus,
} from '@ferretry/protocol';
import type { ConversationCandidate, ConversationDescriber, ConversationFiles } from './conversation-describer.ts';
import { codexIndexNames } from './conversation-name.ts';

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

export type { ConversationFileEntry, ConversationFileInfo, ConversationFiles } from './conversation-describer.ts';

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

const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
/** How deep Codex nests rollouts (`sessions/YYYY/MM/DD/`), plus one level of slack. */
const CODEX_MAX_DEPTH = 4;

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

/**
 * Lists, previews and adopts a machine's existing conversations.
 *
 * Each listing rescans, so a conversation the owner continued in their own terminal a minute ago is
 * current; a file whose size and modification time are unchanged is not re-parsed.
 */
export class ConversationImportService {
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly files: ConversationFiles,
    /** In preference order: when two homes hold one conversation, the first one's file is used. */
    private readonly roots: readonly ConversationRoot[],
    /** Reads, parses and describes each file: on this thread, or wherever the adapter parses. */
    private readonly describer: ConversationDescriber,
    private readonly owners: ConversationOwners,
    private readonly adopter: ConversationAdopter,
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
    return await this.describer.preview({
      harness,
      source: conversation.source,
      relativePath: conversation.relativePath,
      // The row's id is the one the file's name or its own record gave it, so it names the file again.
      nameId: conversation.id,
    });
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
        const described = await this.describer.describe(candidate);
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

  /**
   * Claude keeps `projects/<folder>/<id>.jsonl` (a subfolder there holds a conversation's sub-agents,
   * which are not conversations an owner had). Codex keeps `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
   */
  private async candidates(root: ConversationRoot): Promise<readonly ConversationCandidate[]> {
    if (root.harness === 'claude') {
      const found: ConversationCandidate[] = [];
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
    const found: ConversationCandidate[] = [];
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
