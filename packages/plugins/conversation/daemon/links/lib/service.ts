import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant, Result } from '@ferretry/std';
import { err } from '@ferretry/std';
import type { z } from 'zod';
import type {
  KeepRequest,
  ForeignHistoryEntrySchema,
  KeepResult,
  LinkableConversation,
  LinkListing,
  LinkPreview,
  LinkQuery,
  LinksFile,
} from '../../../contract/index.ts';
import { CONVERSATION_NAME_MAX, CONVERSATION_PREVIEW_MAX } from '../../../contract/index.ts';
import type { TranscriptHarness } from '../../reader/lib/transcript/types.ts';
import type { ConversationCandidate, ConversationDescriber, ConversationFiles } from './conversation-describer.ts';
import { codexIndexNames } from './conversation-name.ts';

/** One harness conversation as its plugin's `ConversationFinder` reports it. */
interface FoundLink {
  readonly id: string;
  readonly folder: string;
  readonly title?: string;
  readonly updatedAt: Instant;
}

/** A harness plugin as the links see it: its key, which parser reads its files, where its history is, who lists it. */
export interface LinkHarness {
  readonly key: string;
  readonly parser: TranscriptHarness;
  /** Its home folder inside the `harness-history` root (`.claude`, `.codex`). */
  readonly home: string;
  list(): Promise<readonly FoundLink[]>;
}

/** Makes the ferret for one linked conversation. The lead wires it once `StartRequest` carries `harnessConversation`. */
export interface LinkKeeper {
  keep(input: {
    readonly harness: string;
    readonly runtime: string;
    readonly conversation: string;
    readonly folder: string;
    readonly name: string;
    readonly start: boolean;
    /** Ferretry holds its own copy of the conversation file (the owner asked), so the ferret resumes from that. */
    readonly copy: boolean;
  }): Promise<
    Result<
      { readonly ferret: FerretId; readonly name: string; readonly state: 'starting' | 'working' | 'idle' | 'stopped' },
      { readonly code: 'conflict' | 'unavailable' | 'failed'; readonly reason: string }
    >
  >;
}

/** Makes Ferretry's own copy of a conversation file (`source`, below the harness-history root); the original is never changed. */
export interface LinkCopier {
  copy(input: {
    readonly harness: string;
    readonly id: string;
    readonly source: string;
  }): Promise<Result<void, { readonly reason: string }>>;
}

/** Where the kept links are written (`links.json`) and read. */
export interface LinkLedger {
  read(): Promise<LinksFile>;
  add(link: LinksFile['links'][number]): Promise<void>;
}

/** `finder.json`: where each harness conversation's file was last found, so a listing scans only for ones it has not seen. */
export interface FinderCache {
  read(): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>>;
  write(files: Readonly<Record<string, Readonly<Record<string, string>>>>): Promise<void>;
}

export interface LinkServiceNeeds {
  readonly finder: FinderCache;
  readonly harnesses: () => readonly LinkHarness[];
  readonly files: ConversationFiles;
  readonly describer: ConversationDescriber;
  readonly ledger: LinkLedger;
  readonly keeper: LinkKeeper;
  readonly copier: LinkCopier;
  readonly now: () => Instant;
  readonly keptPublished?: (ferret: FerretId, link: string) => void;
}

/** The most messages a foreign history entry shows. */
const HISTORY_MESSAGES = 200;

type ForeignHistoryEntry = z.infer<typeof ForeignHistoryEntrySchema>;
type ForeignHistoryList = { readonly entries: readonly ForeignHistoryEntry[]; readonly skipped: number };
type ForeignHistoryDetail = { readonly entry: ForeignHistoryEntry; readonly messages: LinkPreview['messages'] };

const CODEX_INDEX = 'session_index.jsonl';
const CODEX_INDEX_READ_MAX_BYTES = 1024 * 1024;
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const CODEX_MAX_DEPTH = 4;

/** A listed conversation as the read-only history names it. */
const historyEntryOf = (row: LinkableConversation): ForeignHistoryEntry => ({
  id: row.id,
  harness: row.harness,
  ...(row.name === undefined ? {} : { title: row.name }),
  at: row.lastActivityAt,
  turns: row.turns,
  ...(row.turnsAtLeast === true ? { turnsAtLeast: true as const } : {}),
});

/** The search a listing applies: every word must appear somewhere, and the date is a floor (today's matcher). */
function linkMatcher(query: LinkQuery): (row: LinkableConversation) => boolean {
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

/** A conversation as the service holds it: the wire row, and where its file is. Never sent. */
interface Located {
  readonly row: LinkableConversation;
  readonly candidate: ConversationCandidate | undefined;
}

/**
 * Links (§6.2): lists the conversations the harnesses hold, previews one, and keeps some as ferrets READ FROM THE
 * HARNESS'S OWN FILE, never copied (Q19). Discovery reads and never writes: the file port has no write method.
 *
 * A listing is the harness plugins' own (`ConversationFinder`), described from each transcript file where it can be
 * located, so a conversation the owner continued a minute ago is current. A row whose file cannot be read keeps what its
 * finder said (title, folder, last activity), with its turn count as a floor.
 */
export class LinkService {
  #serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly needs: LinkServiceNeeds) {}

  async list(query: LinkQuery = {}): Promise<LinkListing> {
    // Ferretry's own conversations are ferrets, not links: only the computer's history is listed.
    const computerListed = true;
    if (query.source === 'ferretry') return { conversations: [], matched: 0, skipped: 0 };
    const { located, skipped } = await this.#discover(query.harness);
    const kept = new Map(
      (await this.needs.ledger.read()).links.map(link => [`${link.harness}:${link.id}`, link.ferret]),
    );
    const matching = located.map(item => item.row).filter(linkMatcher(query));
    return {
      conversations: matching.slice(0, query.limit ?? matching.length).map(row => {
        const owner = kept.get(`${row.harness}:${row.id}`);
        return owner === undefined ? row : { ...row, keptBy: owner };
      }),
      matched: matching.length,
      skipped,
      ...(computerListed ? {} : { computerListed: false as const }),
    };
  }

  /** The last few exchanges of one conversation, or `undefined` when no history holds it. Read fresh. */
  async preview(harness: string, id: string): Promise<LinkPreview | undefined> {
    const { located } = await this.#discover(harness);
    const found = located.find(item => item.row.id === id);
    if (found === undefined || found.candidate === undefined) return undefined;
    const preview = await this.needs.describer.preview(found.candidate);
    return preview === undefined ? undefined : { ...preview, harness };
  }

  /** The read-only foreign history (the harness conversations that predate Ferretry): the same finders, never resumable. */
  async history(harness?: string): Promise<ForeignHistoryList> {
    const { located, skipped } = await this.#discover(harness);
    return {
      entries: located.map(({ row }) => historyEntryOf(row)),
      skipped,
    };
  }

  async historyEntry(id: string): Promise<ForeignHistoryDetail | undefined> {
    const { located } = await this.#discover(undefined);
    const found = located.find(item => item.row.id === id);
    if (found === undefined || found.candidate === undefined) return undefined;
    const preview = await this.needs.describer.preview(found.candidate, HISTORY_MESSAGES);
    if (preview === undefined) return undefined;
    return {
      entry: historyEntryOf(found.row),
      messages: preview.messages,
    };
  }

  /** One keep at a time, so two pickers can never both keep one conversation. */
  async keep(request: KeepRequest): Promise<KeepResult> {
    const run = this.#serial.then(async () => await this.#keepNow(request));
    this.#serial = run.catch(() => undefined);
    return await run;
  }

  async #keepNow(request: KeepRequest): Promise<KeepResult> {
    const { located } = await this.#discover(request.harness);
    const byId = new Map(located.map(item => [item.row.id, item.row]));
    const result: { kept: KeepResult['kept']; refused: KeepResult['refused'] } = { kept: [], refused: [] };
    const taken = new Map(
      (await this.needs.ledger.read()).links.map(link => [`${link.harness}:${link.id}`, link.ferret]),
    );
    for (const item of request.conversations) {
      const row = byId.get(item.id);
      if (row === undefined) {
        result.refused.push({
          id: item.id,
          code: 'not_found',
          reason: `No ${request.harness} conversation ${item.id} is on this machine.`,
        });
        continue;
      }
      const owner = taken.get(`${request.harness}:${item.id}`);
      if (owner !== undefined) {
        result.refused.push({ id: item.id, code: 'already_kept', reason: `Ferret ${owner} already keeps it.` });
        continue;
      }
      const copy = item.copy === true;
      if (copy) {
        const source = located.find(each => each.row.id === item.id)?.candidate?.source;
        const copied =
          source === undefined
            ? err({ reason: 'Its file could not be found to copy.' })
            : await this.needs.copier.copy({ harness: request.harness, id: item.id, source }).catch((error: unknown) =>
                err({
                  reason: error instanceof Error && error.message !== '' ? error.message : 'It could not be copied.',
                }),
              );
        if (!copied.ok) {
          result.refused.push({ id: item.id, code: 'failed', reason: copied.error.reason });
          continue;
        }
      }
      const made = await this.needs.keeper
        .keep({
          harness: request.harness,
          runtime: request.runtime,
          conversation: item.id,
          folder: row.project,
          name: row.name ?? row.preview.slice(0, 60),
          start: item.start ?? false,
          copy,
        })
        .catch((error: unknown) =>
          err({
            code: 'failed' as const,
            reason: error instanceof Error && error.message !== '' ? error.message : 'The ferret could not be created.',
          }),
        );
      if (!made.ok) {
        result.refused.push({ id: item.id, code: made.error.code, reason: made.error.reason });
        continue;
      }
      await this.needs.ledger.add({
        id: item.id,
        harness: request.harness,
        ferret: made.value.ferret,
        linkedAt: this.needs.now(),
        ...(copy ? { copied: true as const } : {}),
      });
      taken.set(`${request.harness}:${item.id}`, made.value.ferret);
      this.needs.keptPublished?.(made.value.ferret, item.id);
      result.kept.push({ id: item.id, ferret: made.value.ferret, name: made.value.name, state: made.value.state });
    }
    return result;
  }

  async #discover(harness: string | undefined): Promise<{ located: readonly Located[]; skipped: number }> {
    const located: Located[] = [];
    let skipped = 0;
    const seen = new Set<string>();
    for (const each of this.needs.harnesses()) {
      if (harness !== undefined && each.key !== harness) continue;
      const found = await each.list().catch((): readonly FoundLink[] => []);
      const files = await this.#files(
        each,
        found.map(item => item.id),
      );
      const names = await this.#codexNames(each);
      for (const conversation of found) {
        if (seen.has(`${each.key}:${conversation.id}`)) continue;
        seen.add(`${each.key}:${conversation.id}`);
        const candidate = files.get(conversation.id);
        const described = candidate === undefined ? undefined : await this.needs.describer.describe(candidate);
        if (candidate !== undefined && described === undefined) skipped += 1;
        const name = names.get(conversation.id) ?? described?.name ?? conversation.title;
        const row: LinkableConversation =
          described === undefined
            ? {
                id: conversation.id,
                harness: each.key,
                project: conversation.folder,
                ...(name === undefined || name === '' ? {} : { name: name.slice(0, CONVERSATION_NAME_MAX) }),
                preview: (conversation.title ?? '').slice(0, CONVERSATION_PREVIEW_MAX),
                lastActivityAt: conversation.updatedAt,
                turns: 0,
                turnsAtLeast: true,
                keptIn: 'computer',
              }
            : {
                ...described,
                harness: each.key,
                ...(name === undefined || name === '' ? {} : { name: name.slice(0, CONVERSATION_NAME_MAX) }),
                keptIn: 'computer',
              };
        located.push({ row, candidate });
      }
    }
    located.sort((left, right) => Date.parse(right.row.lastActivityAt) - Date.parse(left.row.lastActivityAt));
    return { located, skipped };
  }

  /** Codex's own name for each thread, which wins over the one a rollout recorded: it is what `resume` reads. */
  async #codexNames(harness: LinkHarness): Promise<ReadonlyMap<string, string>> {
    if (harness.parser !== 'codex') return new Map();
    const text = await this.needs.files.tail(`${harness.home}/${CODEX_INDEX}`, CODEX_INDEX_READ_MAX_BYTES);
    return text === undefined ? new Map() : codexIndexNames(text);
  }

  /**
   * Where each conversation's file is. Claude keeps `projects/<folder>/<id>.jsonl` (a subfolder there holds a
   * conversation's sub-agents, which are not conversations an owner had). Codex keeps
   * `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
   */
  async #files(harness: LinkHarness, ids: readonly string[]): Promise<ReadonlyMap<string, ConversationCandidate>> {
    const cache = await this.needs.finder.read().catch(() => ({}) as Record<string, Record<string, string>>);
    const hinted = cache[harness.key] ?? {};
    const known = new Map<string, ConversationCandidate>();
    for (const id of ids) {
      const relative = hinted[id];
      if (relative !== undefined && (await this.needs.files.info(`${harness.home}/${relative}`)) !== undefined)
        known.set(id, {
          harness: harness.parser,
          source: `${harness.home}/${relative}`,
          relativePath: relative,
          nameId: id,
        });
    }
    if (ids.every(id => known.has(id))) return known;
    const scanned = await this.#scan(harness);
    const next: Record<string, string> = {};
    for (const [id, candidate] of scanned) next[id] = candidate.relativePath;
    await this.needs.finder.write({ ...cache, [harness.key]: next }).catch(() => undefined);
    return scanned;
  }

  async #scan(harness: LinkHarness): Promise<ReadonlyMap<string, ConversationCandidate>> {
    const found = new Map<string, ConversationCandidate>();
    const { files } = this.needs;
    if (harness.parser === 'claude') {
      for (const project of await files.entries(`${harness.home}/projects`)) {
        if (project.kind !== 'directory') continue;
        for (const entry of await files.entries(`${harness.home}/projects/${project.name}`)) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
          const id = entry.name.slice(0, -'.jsonl'.length);
          const relative = `projects/${project.name}/${entry.name}`;
          found.set(id, {
            harness: 'claude',
            source: `${harness.home}/${relative}`,
            relativePath: relative,
            nameId: id,
          });
        }
      }
      return found;
    }
    const pending: { readonly relative: string; readonly depth: number }[] = [{ relative: 'sessions', depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const entry of await files.entries(`${harness.home}/${next.relative}`)) {
        const relative = `${next.relative}/${entry.name}`;
        if (entry.kind === 'directory' && next.depth < CODEX_MAX_DEPTH)
          pending.push({ relative, depth: next.depth + 1 });
        else if (entry.kind === 'file' && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          const id = ROLLOUT_ID.exec(entry.name)?.[1];
          if (id !== undefined)
            found.set(id, {
              harness: 'codex',
              source: `${harness.home}/${relative}`,
              relativePath: relative,
              nameId: id,
            });
        }
      }
    }
    return found;
  }
}
