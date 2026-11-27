import type { ConversationSource, FerretId, StagedConversation } from '@ferretry/core-ferrets/contract';
import type { Instant, Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
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
import type { HarnessHistoryKind } from '@ferretry/core-ferrets/contract';
import type { ConversationIndex, IndexedConversation } from './conversation-index.ts';

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

/** Where one listed conversation's transcript is: its tree (by kind and label) and its path inside it. */
interface TranscriptLocation {
  readonly kind: HarnessHistoryKind;
  readonly label: string;
  readonly path: string;
}

/** Makes Ferretry's own copy of a conversation file; the original is never changed. */
export interface LinkCopier {
  copy(input: {
    readonly harness: string;
    readonly id: string;
    readonly location: TranscriptLocation;
  }): Promise<Result<void, { readonly reason: string }>>;
}

/** The last few exchanges of one listed conversation, read fresh from its one file. */
export interface LinkPreviewer {
  preview(conversation: IndexedConversation, count?: number): Promise<LinkPreview | undefined>;
}

/** Where the kept links are written (`links.json`) and read. */
export interface LinkLedger {
  read(): Promise<LinksFile>;
  add(link: LinksFile['links'][number]): Promise<void>;
}

export interface LinkServiceNeeds {
  /** Every listing, preview and keep reads the index: no transcript is opened to list. */
  readonly index: Pick<ConversationIndex, 'ready' | 'query' | 'get'>;
  /** The live registry, including stopped continuations whose owners are not in links.json. */
  readonly owners: () => Promise<ReadonlyMap<string, FerretId>>;
  readonly previewer: LinkPreviewer;
  readonly ledger: LinkLedger;
  readonly keeper: LinkKeeper;
  readonly copier: LinkCopier;
  readonly now: () => Instant;
  readonly keptPublished?: (ferret: FerretId, link: string) => void;
  /**
   * "Keep in sync" (`conversation.yaml` `keepInSync`), asked afresh on EVERY listing so an edit of the file is in
   * effect for the next one. Off: the computer's own conversations are not listed. Absent: on, as a file that says
   * nothing.
   */
  readonly keepInSync?: () => boolean;
}

/** The most messages a foreign history entry shows. */
const HISTORY_MESSAGES = 200;

type ForeignHistoryEntry = z.infer<typeof ForeignHistoryEntrySchema>;
type ForeignHistoryList = {
  readonly entries: readonly ForeignHistoryEntry[];
  readonly skipped: number;
  readonly skippedBy?: Readonly<Record<string, number>>;
};
type ForeignHistoryDetail = { readonly entry: ForeignHistoryEntry; readonly messages: LinkPreview['messages'] };

/** A listed conversation as the read-only history names it. */
const historyEntryOf = (row: LinkableConversation): ForeignHistoryEntry => ({
  id: row.id,
  harness: row.harness,
  ...(row.name === undefined ? {} : { title: row.name }),
  at: row.lastActivityAt,
  turns: row.turns,
  ...(row.turnsAtLeast === true ? { turnsAtLeast: true as const } : {}),
});

/** The words a search must all find (lower-case), or none. The index applies them, as the matcher always did. */
const wordsOfQuery = (query: LinkQuery): readonly string[] =>
  (query.q ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

/** Which kinds of history a listing's `source` asks for: Ferretry's own (ferret homes and the pool), the computer's, or all. */
const kindsOf = (source: LinkQuery['source']): readonly HarnessHistoryKind[] | undefined =>
  source === 'ferretry' ? ['ferret-home', 'pool'] : source === 'computer' ? ['computer'] : undefined;

/**
 * Links (§6.2): lists the conversations the harnesses hold, previews one, and keeps some as ferrets READ FROM THE
 * HARNESS'S OWN FILE, never copied (Q19). Discovery reads and never writes: the file port has no write method.
 *
 * A listing is ONE QUERY of the conversation index (`conversation-index.ts`), which an incremental updater keeps current from
 * the transcripts' sizes and modification times, so it never opens a transcript and is not slowed by how many there are. A
 * listing never waits for a first build: it answers with what is indexed and says it is still being read.
 */
export class LinkService {
  #serial: Promise<unknown> = Promise.resolve();
  readonly #staging = new Set<string>();

  constructor(private readonly needs: LinkServiceNeeds) {}

  async list(query: LinkQuery = {}): Promise<LinkListing> {
    // "Keep in sync" off: the computer's own conversations are not listed, and the answer says so, so the screen can name
    // the switch instead of "no conversation matches".
    const computerListed = this.needs.keepInSync?.() ?? true;
    if (!computerListed) return { conversations: [], matched: 0, skipped: 0, computerListed: false as const };
    const { indexing } = await this.needs.index.ready();
    const answer = this.needs.index.query({
      harness: query.harness,
      kinds: kindsOf(query.source),
      words: wordsOfQuery(query),
      sinceMs: query.since === undefined ? undefined : Date.parse(query.since),
      limit: query.limit,
    });
    const kept = await this.#kept();
    return {
      conversations: answer.conversations.map(({ row }) => {
        const owner = kept.get(`${row.harness}:${row.id}`) ?? row.ferret;
        return owner === undefined ? row : { ...row, keptBy: owner };
      }),
      matched: answer.matched,
      skipped: answer.skipped,
      ...(answer.skipped > 0 ? { skippedBy: answer.skippedBy } : {}),
      ...(indexing ? { indexing: true as const } : {}),
    };
  }

  /** The last few exchanges of one conversation, or `undefined` when no history holds it. Read fresh from its one file. */
  async preview(harness: string, id: string): Promise<LinkPreview | undefined> {
    await this.needs.index.ready();
    const found = this.needs.index.get(harness, id);
    if (found === undefined) return undefined;
    const preview = await this.needs.previewer.preview(found);
    return preview === undefined ? undefined : { ...preview, harness };
  }

  /**
   * "Continue a past conversation": puts ONE indexed conversation's transcript where its harness resumes from, by the same
   * copy keep uses (the owner's computer copied into the harness's pool; one already pooled needs nothing; the original is
   * never written). It starts no ferret and writes no link: the start that asked for it does. A conversation this machine's
   * index does not hold is `not_found`, one that cannot be copied is `failed`, each with a plain sentence.
   *
   * The keep queue checks registry and ledger ownership and reserves the history through the whole start. A selected row
   * is re-resolved by its opaque index binding; a stale selection never falls back to another copy.
   */
  async stage(
    harness: string,
    id: string,
    selected?: ConversationSource,
  ): Promise<Result<StagedConversation, { code: 'not_found' | 'failed'; reason: string }>> {
    const run = this.#serial.then(async () => await this.#stageNow(harness, id, selected));
    this.#serial = run.catch(() => undefined);
    return await run;
  }

  async #stageNow(
    harness: string,
    id: string,
    selected?: ConversationSource,
  ): Promise<Result<StagedConversation, { code: 'not_found' | 'failed'; reason: string }>> {
    await this.needs.index.ready();
    const owner = (await this.#kept()).get(`${harness}:${id}`);
    if (owner !== undefined) return err({ code: 'failed', reason: `Ferret ${owner} already keeps it.` });
    // Resolve after the last asynchronous ownership read, immediately before reserving and starting the copy.
    const found = this.needs.index.get(harness, id, selected === undefined ? undefined : [selected.kind], selected);
    if (found === undefined)
      return err({ code: 'not_found', reason: `No ${harness} conversation ${id} is on this machine.` });
    const key = `${harness}:${id}`;
    if (this.#staging.has(key)) return err({ code: 'failed', reason: 'That conversation is already being continued.' });
    this.#staging.add(key);
    const copied = await this.needs.copier
      .copy({ harness, id, location: { kind: found.kind, label: found.label, path: found.path } })
      .catch((error: unknown) =>
        err({ reason: error instanceof Error && error.message !== '' ? error.message : 'It could not be copied.' }),
      );
    if (!copied.ok) {
      this.#staging.delete(key);
      return err({ code: 'failed', reason: copied.error.reason });
    }
    return ok({
      release: () => {
        this.#staging.delete(key);
      },
    });
  }

  /** The read-only foreign history (the harness conversations that predate Ferretry): the same index, never resumable. */
  async history(harness?: string): Promise<ForeignHistoryList> {
    await this.needs.index.ready();
    const answer = this.needs.index.query({ harness });
    return {
      entries: answer.conversations.map(({ row }) => historyEntryOf(row)),
      skipped: answer.skipped,
      ...(answer.skipped > 0 ? { skippedBy: answer.skippedBy } : {}),
    };
  }

  async historyEntry(id: string): Promise<ForeignHistoryDetail | undefined> {
    await this.needs.index.ready();
    const found = this.needs.index.get(undefined, id);
    if (found === undefined) return undefined;
    const preview = await this.needs.previewer.preview(found, HISTORY_MESSAGES);
    if (preview === undefined) return undefined;
    return {
      entry: historyEntryOf(found.row),
      messages: preview.messages,
    };
  }

  async #kept(): Promise<ReadonlyMap<string, FerretId>> {
    return new Map([
      ...(await this.needs.ledger.read()).links.map(link => [`${link.harness}:${link.id}`, link.ferret] as const),
      ...(await this.needs.owners()),
    ]);
  }

  /** One keep at a time, so two pickers can never both keep one conversation. */
  async keep(request: KeepRequest): Promise<KeepResult> {
    const run = this.#serial.then(async () => await this.#keepNow(request));
    this.#serial = run.catch(() => undefined);
    return await run;
  }

  async #keepNow(request: KeepRequest): Promise<KeepResult> {
    await this.needs.index.ready();
    const result: { kept: KeepResult['kept']; refused: KeepResult['refused'] } = { kept: [], refused: [] };
    const taken = new Map(await this.#kept());
    for (const item of request.conversations) {
      const found = this.needs.index.get(request.harness, item.id);
      const row = found?.row;
      if (found === undefined || row === undefined) {
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
      if (this.#staging.has(`${request.harness}:${item.id}`)) {
        result.refused.push({
          id: item.id,
          code: 'already_kept',
          reason: 'That conversation is already being continued.',
        });
        continue;
      }
      // A conversation of the owner's computer is ALWAYS copied into the harness's pool first and the ferret resumes the
      // copy: the original keeps working in the owner's own terminal and is never shared with a ferret (one writer per file).
      // (`item.copy` is kept on the request for older callers; it no longer changes anything.)
      const copy = true;
      if (copy) {
        const copied = await this.needs.copier
          .copy({
            harness: request.harness,
            id: item.id,
            location: { kind: found.kind, label: found.label, path: found.path },
          })
          .catch((error: unknown) =>
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
          name: row.ferretName ?? row.title ?? row.preview.slice(0, 60),
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
}
