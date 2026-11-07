import { createHash, randomUUID } from 'node:crypto';
import {
  AgendaConversationEntrySchema,
  AgendaIdSchema,
  type AgendaVersionSummary,
  AgendaVersionSummarySchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { AgendaVia } from '../../lib/agenda/service.ts';
import type { AgendaActor, AgendaEntry } from '../../lib/agenda/state-machine.ts';
import { parseAgendaEntry } from '../../lib/agenda/state-machine.ts';
import type { AgendaVersionDraft } from '../../lib/agenda/versions.ts';
import {
  type AgendaChangeEffect,
  AgendaChangeEffectSchema,
  type AgendaChangeOutboxRuntime,
  FileAgendaChangeOutbox,
} from './file-agenda-change-outbox.ts';

export const AGENDA_VERSION_PENDING = 'agenda-versions.pending.json';
const EntrySchema = z.unknown().transform((value, context) => {
  const entry = parseAgendaEntry(value, false, []);
  if (entry !== null) return entry;
  context.addIssue({ code: 'custom', message: 'invalid prepared agenda entry' });
  return z.NEVER;
});
/** What a file said, as the intent names it: a different text is a different file, whoever wrote it. */
const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The intent once the agenda file it commits is written: all that is left is the change event and the clean-up. It
 * carries no drafts, so a later set-aside can never void what already committed.
 */
const CommittedSchema = z.strictObject({ committed: z.literal(true), effect: AgendaChangeEffectSchema.optional() });

const PreparedSchema = z.strictObject({
  /** The agenda file this commits, as it will be written: replay writes these bytes as they are. */
  ledger: z.string(),
  /** The digest of the agenda file this was prepared from (`null`: there was none) and of the file it commits. */
  base: z.string().nullable(),
  result: z.string(),
  /** Where the history file ended before this change, and the records it appends past that. */
  archive: AgendaArchiveCursorSchema,
  records: z.array(AgendaArchiveRecordSchema),
  effect: AgendaChangeEffectSchema.optional(),
  drafts: z.array(
    z.strictObject({
      mutationId: z.string().min(1),
      entry: EntrySchema,
      conversation: z.array(AgendaConversationEntrySchema).optional(),
      beforeConversation: z.array(AgendaConversationEntrySchema).optional(),
      before: EntrySchema.optional(),
      at: z.string().datetime({ offset: true }),
      by: AgendaVersionSummarySchema.shape.by,
      change: z.string(),
    }),
  ),
});

import {
  AGENDA_ARCHIVE_FILE,
  type AgendaArchiveCursor,
  AgendaArchiveCursorSchema,
  type AgendaArchiveRecord,
  AgendaArchiveRecordSchema,
} from '../../lib/agenda/archive.ts';
import {
  AGENDA_FILES,
  AGENDA_LEDGER_VERSION,
  type AgendaFileStore,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  type AgendaVersionStore,
  agendaLedgerDocument,
  isAgendaSessionId,
  NO_AGENDA_VERSIONS,
  parseAgendaLedger,
  draftsLanded,
  versionDrafts,
} from '../../lib/agenda/index.ts';
import {
  type AppendOnlyFiles,
  appendedCursor,
  appendLogRecords,
  commitLogAppend,
  completeLinesCursor,
  uncommittedLogFrom,
} from '../../lib/append-only-log.ts';
import { deepFreezeJson, type JsonValue } from '../../lib/json.ts';
import type { RecordedItem } from '../../lib/agenda/item-words.ts';
import { FileAgendaFileStore } from './file-agenda-file-store.ts';

/** Raised when a durable board cannot safely be supplied to the state machine. */
export class InvalidAgendaLedgerError extends Error {
  constructor(readonly file: string) {
    super(`invalid agenda ledger: ${file}`);
  }
}

/** How many sessions' parsed agendas are kept; past it the one read longest ago is dropped and read again from disk when asked for. */
export const AGENDA_CACHE_LIMIT = 2_048;

/** The files a repository reads: the agenda's store, with the identity reads the cache is proved by. */
type IdentifiedAgendaFiles = AgendaFileStore &
  AppendOnlyFiles &
  Required<Pick<AgendaFileStore, 'identity' | 'readIdentified'>> &
  Pick<FileAgendaFileStore, 'file'>;

/** One session's agenda as last parsed: which file, how it stood, and what it said. */
interface CachedLedger {
  readonly name: string;
  readonly identity: string;
  /** The digest of the text it was parsed from. */
  readonly digest: string;
  readonly ledger: AgendaLedger;
}

function archiveRecords(text: string): AgendaArchiveRecord[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('incomplete agenda history');
  return text
    .slice(0, -1)
    .split('\n')
    .map(line => AgendaArchiveRecordSchema.parse(JSON.parse(line)));
}

/**
 * Durable per-session agenda storage, as `agenda.json` (a board written before the rename is read from
 * `attention.json` until the migration moves it, and every write goes to `agenda.json`). The owning daemon process supplies one
 * instance, so the keyed queue serializes every read-modify-write transition.
 *
 * A PARSED COPY IS KEPT PER SESSION, against the identity of the file it was read from. A board read opens
 * the agenda of every ferret on the board — some two hundred — and checking each one's ledger entry by entry
 * was most of what it cost. The file stays the only truth: every write lands on disk first and then drops the
 * copy, every read first asks the file how it stands (one `stat`), and a file changed by anyone — this
 * daemon, the CLI, a second process, a person with an editor — is a new identity, read and parsed again. The
 * copy is frozen, because every reader of this session shares it, and lives in memory only: a restart starts
 * from the files.
 */
export class FileAgendaLedgerRepository implements AgendaLedgerRepository {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, CachedLedger>();
  private readonly files: IdentifiedAgendaFiles;
  readonly changeOutbox?: FileAgendaChangeOutbox;

  /** `ready` settles when the agenda files migration has finished; no read or write goes to disk before it. */
  constructor(
    sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
    private readonly ready: Promise<unknown> = Promise.resolve(),
    files?: IdentifiedAgendaFiles,
    /** Where every committed change is kept as a full version; absent, none is. */
    private readonly versions: AgendaVersionStore = NO_AGENDA_VERSIONS,
    private readonly runtime: AgendaChangeOutboxRuntime = { now: Date.now, warn: message => console.warn(message) },
    /** A ledger publication restores its session's membership; this takes no agenda or session document lane. */
    private readonly retained?: (sessionId: string) => Promise<void>,
  ) {
    this.files = files ?? new FileAgendaFileStore(sessionDirectory, uniqueId);
    if (versions !== NO_AGENDA_VERSIONS)
      this.changeOutbox = new FileAgendaChangeOutbox(
        this.files,
        (session, work) =>
          this.serial(session, async () => {
            // No event may be acknowledged while its intent can still replay and enqueue it again.
            await this.recoverVersions(session);
            return work();
          }),
        this.runtime,
      );
  }

  file(sessionId: string): string {
    this.assertSessionId(sessionId);
    return this.files.file(sessionId, AGENDA_FILES.ledger.current);
  }

  async read(sessionId: string): Promise<AgendaLedger | null> {
    this.assertSessionId(sessionId);
    await this.ready;
    return this.serial(sessionId, async () => {
      await this.recoverVersions(sessionId);
      return this.load(sessionId);
    });
  }

  private async load(sessionId: string): Promise<AgendaLedger | null> {
    return (await this.loadDigested(sessionId))?.ledger ?? null;
  }

  /** The agenda as the reader would read it, with the digest of the text it came from. */
  private async loadDigested(sessionId: string): Promise<{ ledger: AgendaLedger; digest: string } | null> {
    // THE READER'S RULE (`readAgendaFile`): the new name when it exists, else the old one.
    for (const name of [AGENDA_FILES.ledger.current, AGENDA_FILES.ledger.legacy]) {
      const now = await this.files.identity(sessionId, name);
      if (now === undefined) continue;
      const cached = this.cache.get(sessionId);
      if (cached !== undefined && cached.name === name && cached.identity === now) {
        this.cache.delete(sessionId);
        this.cache.set(sessionId, cached);
        return cached;
      }
      const read = await this.files.readIdentified(sessionId, name);
      if (read === undefined) continue;
      const ledger = deepFreezeJson(
        (await this.parse(sessionId, name, read.text)) as unknown as JsonValue,
      ) as unknown as AgendaLedger;
      this.cache.delete(sessionId);
      for (const oldest of this.cache.keys()) {
        if (this.cache.size < AGENDA_CACHE_LIMIT) break;
        this.cache.delete(oldest);
      }
      const found = { name, identity: read.identity, digest: digestOf(read.text), ledger };
      this.cache.set(sessionId, found);
      return found;
    }
    this.cache.delete(sessionId);
    return null;
  }

  private async parse(sessionId: string, name: string, text: string): Promise<AgendaLedger> {
    let raw: Record<string, unknown> | null;
    let cursor: AgendaArchiveCursor | undefined;
    try {
      raw = JSON.parse(text) as Record<string, unknown> | null;
      cursor = AgendaArchiveCursorSchema.optional().parse(raw?.archive);
    } catch {
      throw new InvalidAgendaLedgerError(this.files.file(sessionId, name));
    }
    const version = raw?.version;
    // An older daemon's write drops the cursor and the version but leaves the sidecar: its complete lines are
    // the history it was keeping, so they are adopted as committed rather than cut as an uncommitted tail. A
    // pre-cursor ledger whose own write failed after an append looks the same, so the append's mark stops the
    // adoption where that never-committed append began. The history is read before the mark: a write racing
    // this read marks before it appends, so any appended byte read here has its mark there to be read next.
    let history: Buffer | undefined;
    let adopted: AgendaArchiveCursor | undefined;
    if ((version === undefined || version === 1) && cursor === undefined) {
      history = Buffer.from(await this.files.readAfter(sessionId, AGENDA_ARCHIVE_FILE, 0));
      const uncommitted = await uncommittedLogFrom(this.files, sessionId, AGENDA_ARCHIVE_FILE);
      const lines = completeLinesCursor(uncommitted === undefined ? history : history.subarray(0, uncommitted));
      if (lines.count > 0) adopted = lines;
    }
    const committed = cursor ?? adopted;
    // A board an older daemon wrote after this one kept its words has lost them: they are read back from the items'
    // recorded versions, outside the parse so that a version store that cannot answer is not a damaged board.
    const recorded = version === AGENDA_LEDGER_VERSION ? undefined : await this.recordedItems(sessionId, raw);
    try {
      let archived: AgendaArchiveRecord[] = [];
      if (version !== AGENDA_LEDGER_VERSION && committed !== undefined && committed.bytes > 0) {
        // Read-time migration reads only the committed prefix. An interrupted or concurrent append beyond
        // its cursor belongs to a later hot ledger, never this snapshot. Modern ledgers never read this file.
        history ??= Buffer.from(await this.files.readAfter(sessionId, AGENDA_ARCHIVE_FILE, 0));
        if (history.length < committed.bytes) throw new Error('incomplete agenda history');
        archived = archiveRecords(history.subarray(0, committed.bytes).toString('utf8'));
      }
      const ledger = parseAgendaLedger(raw, sessionId, archived, recorded);
      if (ledger === null) throw new Error('invalid ledger');
      return adopted === undefined ? ledger : { ...ledger, archive: adopted };
    } catch {
      throw new InvalidAgendaLedgerError(this.files.file(sessionId, name));
    }
  }

  /** The latest kept version of each item the document names (a voided one is gone from the store); an item never versioned has none. */
  private async recordedItems(
    sessionId: string,
    raw: Record<string, unknown> | null,
  ): Promise<Record<string, RecordedItem> | undefined> {
    if (this.versions === NO_AGENDA_VERSIONS || !Array.isArray(raw?.entries)) return undefined;
    const recorded: Record<string, RecordedItem> = {};
    for (const entry of raw.entries as unknown[]) {
      const id = AgendaIdSchema.safeParse((entry as { item?: { id?: unknown } } | null)?.item?.id);
      if (!id.success) continue;
      const latest = (await this.versions.list(sessionId, id.data)).at(-1);
      if (latest === undefined) continue;
      const version = await this.versions.get(sessionId, id.data, latest.version);
      const conversation = await this.versions.conversation?.(sessionId, id.data, latest.version);
      if (version !== undefined && conversation !== undefined)
        recorded[id.data] = { at: version.at, item: version.item, conversation };
    }
    return Object.keys(recorded).length === 0 ? undefined : recorded;
  }

  /** The text of the agenda file the reader would read, or `undefined` when there is none. */
  private async ledgerText(sessionId: string): Promise<string | undefined> {
    for (const name of [AGENDA_FILES.ledger.current, AGENDA_FILES.ledger.legacy]) {
      const text = await this.files.read(sessionId, name);
      if (text !== undefined) return text;
    }
    return undefined;
  }

  /** The digest of the agenda file the reader would read, or `null` when there is none. */
  private async ledgerDigest(sessionId: string): Promise<string | null> {
    const text = await this.ledgerText(sessionId);
    return text === undefined ? null : digestOf(text);
  }

  async transact(
    sessionId: string,
    apply: (current: AgendaLedger | null) => AgendaMutation,
    by: AgendaVersionSummary['by'] = 'daemon',
    provenance?: { readonly actor: AgendaActor; readonly via: AgendaVia },
  ): Promise<AgendaMutation> {
    this.assertSessionId(sessionId);
    return await this.serial(sessionId, async () => {
      await this.ready;
      await this.recoverVersions(sessionId);
      const loaded = await this.loadDigested(sessionId);
      let current = loaded?.ledger ?? null;
      let base = loaded?.digest ?? null;
      // Migrate old in-ledger history before applying even an unchanged command. Appending precedes the
      // atomic cursor write; a retry after a crash cuts the uncommitted append and writes it once again.
      if ((current?.archivePending?.length ?? 0) > 0 && current !== null) {
        current = await this.write(sessionId, current);
        base = await this.ledgerDigest(sessionId);
      }
      const mutation = apply(current);
      if (mutation.ok && mutation.changed) {
        if (this.versions === NO_AGENDA_VERSIONS)
          return { ...mutation, ledger: await this.write(sessionId, mutation.ledger) };
        const drafts = [...versionDrafts(current, mutation, by)];
        const { committed, records } = this.plan(await this.coldVersions(sessionId, mutation.ledger, current, drafts));
        const document = agendaLedgerDocument(committed);
        const archive = mutation.ledger.archive ?? { bytes: 0, count: 0 };
        const mutationId = this.uniqueId();
        const identified = drafts.map((draft, index) => ({ ...draft, mutationId: `${mutationId}:${index}` }));
        const effect: AgendaChangeEffect | undefined =
          provenance === undefined || mutation.change === 'unchanged'
            ? undefined
            : {
                id: mutationId,
                event: {
                  ...provenance,
                  change: mutation.change,
                  snapshot: mutation.snapshot,
                  ...(mutation.item === undefined ? {} : { item: mutation.item }),
                  ...(mutation.addressed === undefined ? {} : { addressed: mutation.addressed }),
                },
              };
        // This fsynced intent precedes archive requests and the hot commit. Recovery always replays the SAME
        // snapshots and per-item identity, including a worker commit whose acknowledgement was lost, and only
        // while the agenda file is still the one it was prepared from or the one it commits.
        await this.files.writeAtomic(
          sessionId,
          AGENDA_VERSION_PENDING,
          JSON.stringify({
            ledger: document,
            base,
            result: digestOf(document),
            archive,
            records,
            drafts: identified,
            effect,
          }),
        );
        await this.commitVersions(sessionId, { document, archive, records }, identified, effect);
        return { ...mutation, ledger: committed };
      }
      return mutation;
    });
  }

  private async recoverVersions(sessionId: string): Promise<void> {
    const text = await this.files.read(sessionId, AGENDA_VERSION_PENDING);
    if (text === undefined) return;
    if (this.versions === NO_AGENDA_VERSIONS)
      throw new Error('agenda version archive is required to recover this transaction');
    const raw: unknown = JSON.parse(text);
    const committed = CommittedSchema.safeParse(raw);
    if (committed.success) {
      await this.finish(sessionId, committed.data.effect);
      return;
    }
    const prepared = PreparedSchema.parse(raw);
    const found = await this.ledgerText(sessionId);
    const now = found === undefined ? null : digestOf(found);
    if (now === prepared.result) {
      // The agenda file it commits is already written, and its history records were appended before that: nothing is
      // appended or written again, so a crash here cannot leave the history shorter than the file's cursor.
      await this.finish(sessionId, prepared.effect);
      return;
    }
    if (now !== prepared.base) {
      // The agenda file is neither what this was prepared from nor what it commits: another daemon wrote it since
      // (a rollback to one that ignores this file). Replaying would overwrite that daemon's words, and its history
      // appends would be cut back to a cursor behind its own. The intent is kept aside, never replayed.
      if (draftsLanded(found, prepared.drafts)) {
        // The hot commit landed and only its clean-up did not: the change is the board's own, and so are its versions.
        await this.finish(sessionId, prepared.effect);
        this.runtime.warn(
          `agenda ${sessionId}: an unfinished change had committed before the agenda file was written by another daemon, so its versions and change event were kept`,
        );
        return;
      }
      const kept = await this.setAside(sessionId, text);
      // What it recorded never committed, and the board now belongs to someone else's items: none of it may
      // become a base for them (a different item can hold the same id, or the same item other words).
      await this.versions.discard?.(sessionId, prepared.drafts);
      await this.files.remove(sessionId, AGENDA_VERSION_PENDING);
      this.runtime.warn(
        `agenda ${sessionId}: an unfinished change was set aside as ${kept} because the agenda file was written by another daemon since, and the versions it had recorded were voided`,
      );
      return;
    }
    await this.parse(sessionId, AGENDA_VERSION_PENDING, prepared.ledger);
    await this.commitVersions(
      sessionId,
      { document: prepared.ledger, archive: prepared.archive, records: prepared.records },
      prepared.drafts,
      prepared.effect,
    );
  }

  /** Keeps a set-aside intent where it can be read: `.stale`, and beside an earlier one under a name of its own. */
  private async setAside(sessionId: string, text: string): Promise<string> {
    const first = `${AGENDA_VERSION_PENDING}.stale`;
    const held = await this.files.read(sessionId, first);
    const name = held === undefined || held === text ? first : `${first}-${digestOf(text).slice(0, 16)}`;
    await this.files.writeAtomic(sessionId, name, text);
    return name;
  }

  private async commitVersions(
    sessionId: string,
    commit: {
      readonly document: string;
      readonly archive: AgendaArchiveCursor;
      readonly records: readonly AgendaArchiveRecord[];
    },
    drafts: readonly AgendaVersionDraft[],
    effect?: AgendaChangeEffect,
  ): Promise<void> {
    await this.versions.record(sessionId, drafts);
    // The moment the agenda file lands the intent says so, ahead of the history mark and the event: from there on a
    // failure leaves a committed intent, which nothing sets aside.
    await this.commit(sessionId, commit.document, commit.archive, commit.records, () =>
      this.files.writeAtomic(sessionId, AGENDA_VERSION_PENDING, JSON.stringify({ committed: true, effect })),
    );
    await this.retire(sessionId, effect);
  }

  /** What follows a committed agenda file: its history mark lifted, its change event kept, its intent retired. */
  private async finish(sessionId: string, effect: AgendaChangeEffect | undefined): Promise<void> {
    await commitLogAppend(this.files, sessionId, AGENDA_ARCHIVE_FILE);
    await this.retire(sessionId, effect);
  }

  private async retire(sessionId: string, effect: AgendaChangeEffect | undefined): Promise<void> {
    if (effect !== undefined) await this.changeOutbox?.append(sessionId, effect);
    await this.files.remove(sessionId, AGENDA_VERSION_PENDING);
  }

  /** Cold threads leave the hot maps only after their complete snapshots have been acknowledged by SQLite. */
  private async coldVersions(
    sessionId: string,
    ledger: AgendaLedger,
    before: AgendaLedger | null,
    drafts: AgendaVersionDraft[],
  ): Promise<AgendaLedger> {
    const live = new Set(ledger.entries.map(entry => entry.item.id));
    // Raw entries remain in agenda.json until repaired or explicitly pruned. Their sidecars are still live too.
    for (const raw of ledger.unreadable ?? []) {
      const preserved = z.object({ item: z.object({ id: z.string() }) }).safeParse(raw);
      if (preserved.success) live.add(preserved.data.item.id);
    }
    const conversations = { ...ledger.conversations };
    const carriedEntries = { ...ledger.carriedEntries };
    for (const id of new Set([...Object.keys(conversations), ...Object.keys(carriedEntries)])) {
      if (live.has(id)) continue;
      let entry = before?.entries.find(entry => entry.item.id === id);
      if (entry === undefined) {
        const latest = (await this.versions.list(sessionId, id)).at(-1);
        const version = latest === undefined ? undefined : await this.versions.get(sessionId, id, latest.version);
        const records =
          version === undefined ? [...(await this.archiveInQueue(sessionId)), ...(ledger.archivePending ?? [])] : [];
        const record = records.findLast(record => record.kind === 'version' && record.id === id);
        const item = version?.item ?? (record?.kind === 'version' ? record.item : undefined);
        if (item === undefined) {
          entry = carriedEntries[id];
          if (entry === undefined) throw new Error('missing cold agenda snapshot');
        } else {
          const origin =
            item.raisedBy === 'agent'
              ? { kind: 'agent' as const, sessionId: item.raisedBySession ?? sessionId, name: item.raisedByName }
              : item.raisedBy === 'human'
                ? { kind: 'human' as const }
                : { kind: 'daemon' as const, cause: 'system' as const };
          entry = { origin, lifecycle: 'resolvedAt' in item ? 'addressed' : 'active', item } as AgendaEntry;
        }
      }
      const carried = carriedEntries[id];
      if (carried !== undefined)
        drafts.push({
          entry: carried,
          at: ledger.updatedAt,
          by: 'daemon',
          change: 'carried',
          conversation: carried.item.conversation ?? [],
        });
      drafts.push({
        entry,
        before: carriedEntries[id] ?? entry,
        beforeConversation: conversations[id] ?? entry.item.conversation ?? [],
        conversation: conversations[id] ?? entry.item.conversation ?? [],
        at: ledger.updatedAt,
        by: 'daemon',
        change: 'archived',
      });
      delete conversations[id];
      delete carriedEntries[id];
    }
    return { ...ledger, conversations, carriedEntries };
  }

  /**
   * Explicit, lazy history read. Snapshots and transactions never read committed archive records. It queues
   * behind writers and serves only the bytes the ledger's cursor has committed: a record appended by a
   * transaction whose ledger write then failed, or torn by a crash, is not history.
   */
  async readArchive(sessionId: string): Promise<readonly AgendaArchiveRecord[]> {
    this.assertSessionId(sessionId);
    await this.ready;
    return await this.serial(sessionId, async () => {
      await this.recoverVersions(sessionId);
      return this.archiveInQueue(sessionId);
    });
  }

  /** The committed history only, inside the session's queue: bytes past the ledger's cursor were never committed. */
  private async archiveInQueue(sessionId: string): Promise<AgendaArchiveRecord[]> {
    const committed = (await this.load(sessionId))?.archive?.bytes ?? 0;
    if (committed === 0) return [];
    const bytes = Buffer.from(await this.files.readAfter(sessionId, AGENDA_ARCHIVE_FILE, 0));
    if (bytes.length < committed) throw new Error('incomplete agenda history');
    return archiveRecords(bytes.subarray(0, committed).toString('utf8'));
  }

  /** The ledger a write commits, and the history records it appends first: what the write will do, without doing it. */
  private plan(ledger: AgendaLedger): { committed: AgendaLedger; records: readonly AgendaArchiveRecord[] } {
    const { archivePending, ...clean } = ledger;
    const records = archivePending ?? [];
    const archive =
      records.length === 0 ? clean.archive : appendedCursor(ledger.archive ?? { bytes: 0, count: 0 }, records);
    return { committed: { ...clean, ...(archive === undefined ? {} : { archive }) }, records };
  }

  private async write(sessionId: string, ledger: AgendaLedger): Promise<AgendaLedger> {
    const { committed, records } = this.plan(ledger);
    await this.commit(sessionId, agendaLedgerDocument(committed), ledger.archive ?? { bytes: 0, count: 0 }, records);
    return committed;
  }

  /** The history records first, from where the file said it ended, then the agenda file as given, then `landed`. */
  private async commit(
    sessionId: string,
    document: string,
    archive: AgendaArchiveCursor,
    records: readonly AgendaArchiveRecord[],
    landed?: () => Promise<void>,
  ): Promise<void> {
    try {
      await appendLogRecords(this.files, sessionId, AGENDA_ARCHIVE_FILE, archive, records);
      await this.files.writeAtomic(sessionId, AGENDA_FILES.ledger.current, document);
      await this.retained?.(sessionId);
      await landed?.();
      // The ledger now says where history ends (or that a version-2 board has none), so no append is pending.
      await commitLogAppend(this.files, sessionId, AGENDA_ARCHIVE_FILE);
    } finally {
      // After the disk, whether or not it landed: the next read asks the file. A read racing this write may
      // keep the old copy, but against the old file's identity, which the next read no longer finds.
      this.cache.delete(sessionId);
    }
  }

  private async serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId);
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
  }
}
