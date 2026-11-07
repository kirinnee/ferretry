import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgendaConversationEntry,
  AgendaConversationEntrySchema,
  type AgendaId,
  AgendaIdSchema,
} from '../../lib/protocol/agenda.ts';
import {
  type AgendaVersion,
  AgendaVersionSchema,
  type AgendaVersionSummary,
  AgendaVersionSummarySchema,
} from '../../lib/protocol/agenda-versions.ts';
import { z } from 'zod';
import {
  type AgendaVersionDraft,
  type AgendaVersionStore,
  CARRIED_VERSION,
  isAgendaSessionId,
} from '../../lib/agenda/index.ts';
import { deepFreezeJson, type JsonValue } from '../../lib/json.ts';

/** The directory beside a session's board that holds one indexed version archive per item. */
export const AGENDA_VERSIONS_DIRECTORY = 'agenda-versions';

/** Earlier draft sidecars held whole conversations beside (or inside) each snapshot. */
const StoredVersionSchema = z.strictObject({
  snapshot: AgendaVersionSchema,
  conversation: z.array(AgendaConversationEntrySchema).optional(),
});
type StoredVersion = z.infer<typeof StoredVersionSchema>;

/** Import every complete legacy record, including a valid final record without a newline; skip torn records. */
function versionsIn(text: string): StoredVersion[] {
  const versions: StoredVersion[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      const parsed = StoredVersionSchema.safeParse(value);
      if (parsed.success) versions.push(parsed.data);
      else {
        const legacy = AgendaVersionSchema.safeParse(value);
        if (legacy.success) versions.push({ snapshot: legacy.data });
      }
    } catch {
      // A torn legacy tail does not discard the complete versions before it.
    }
  }
  return versions;
}

const summaryOf = (version: AgendaVersion): AgendaVersionSummary => ({
  version: version.version,
  at: version.at,
  by: version.by,
  change: version.change,
  lifecycle: version.lifecycle,
});

/** A single immutable version cached for fragment paging; moving to another version releases the previous thread. */
interface CachedVersion {
  readonly key: string;
  readonly snapshot: AgendaVersion;
  conversation?: readonly AgendaConversationEntry[];
}

/**
 * `agenda-versions/<id>.sqlite`: complete bounded snapshots indexed by version, immutable words keyed by SHA-256,
 * and per-version ordered word references. Appends inspect only the largest primary key, never historical payloads.
 * SQLite commits a version and all its references together; an interrupted append cannot publish half a version.
 * The caller serializes writes per session. Connections close after each operation; at most one read version is cached.
 * Earlier draft JSONL archives are imported once, atomically, and left untouched. A torn legacy tail is ignored;
 * subsequent numbering follows the complete imported versions. No deployed format needs a rolling dual writer.
 */
export class SqliteAgendaVersionStore implements AgendaVersionStore {
  private cached: CachedVersion | undefined;

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly connect: (file: string) => Database = file => new Database(file),
  ) {}

  private file(sessionId: string, id: AgendaId): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    if (!AgendaIdSchema.safeParse(id).success) throw new Error(`not a valid agenda id: ${id}`);
    return join(this.sessionDirectory(sessionId), AGENDA_VERSIONS_DIRECTORY, `${id}.sqlite`);
  }

  /** A read opens only what a record created: an id nothing was recorded for has no store, and asking never makes one. */
  private async openExisting(sessionId: string, id: AgendaId): Promise<Database | undefined> {
    const file = this.file(sessionId, id);
    for (const candidate of [file, file.replace(/\.sqlite$/u, '.jsonl')]) {
      const present = await access(candidate).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        },
      );
      if (present) return await this.open(sessionId, id);
    }
    return undefined;
  }

  private async open(sessionId: string, id: AgendaId): Promise<Database> {
    const file = this.file(sessionId, id);
    await mkdir(join(this.sessionDirectory(sessionId), AGENDA_VERSIONS_DIRECTORY), { recursive: true, mode: 0o700 });
    // Create privately before SQLite opens it; journal files inherit its permissions.
    await writeFile(file, '', { flag: 'a', mode: 0o600 });
    const db = this.connect(file);
    try {
      const initialized = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
      if (initialized?.user_version === 2) return db;
      if (initialized?.user_version === 1) {
        db.transaction(() => {
          db.exec('CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY) WITHOUT ROWID');
          db.exec('PRAGMA user_version = 2');
        })();
        return db;
      }
      let legacy = '';
      try {
        legacy = await readFile(file.replace(/\.sqlite$/u, '.jsonl'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      db.transaction(() => {
        // Another reader may have finished initialization while this one awaited the legacy file.
        if (db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version === 2) return;
        db.exec(`
          CREATE TABLE mutations (id TEXT PRIMARY KEY) WITHOUT ROWID;
          CREATE TABLE versions (version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, summary TEXT NOT NULL);
          CREATE TABLE words (hash TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE version_words (
            version INTEGER NOT NULL, position INTEGER NOT NULL, hash TEXT NOT NULL,
            PRIMARY KEY (version, position)
          ) WITHOUT ROWID;
        `);
        for (const record of versionsIn(legacy)) this.save(db, record.snapshot, record.conversation);
        db.exec('PRAGMA user_version = 2');
      })();
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private save(db: Database, snapshot: AgendaVersion, conversation?: readonly AgendaConversationEntry[]): void {
    const inserted = db
      .query('INSERT OR IGNORE INTO versions VALUES (?, ?, ?)')
      .run(snapshot.version, JSON.stringify(snapshot), JSON.stringify(summaryOf(snapshot)));
    if (inserted.changes === 0) return;
    const insertWords = db.query('INSERT OR IGNORE INTO words VALUES (?, ?)');
    const reference = db.query('INSERT INTO version_words VALUES (?, ?, ?)');
    for (const [position, entry] of (conversation ?? snapshot.item.conversation ?? []).entries()) {
      const text = JSON.stringify(AgendaConversationEntrySchema.parse(entry));
      const hash = createHash('sha256').update(text).digest('hex');
      insertWords.run(hash, text);
      reference.run(snapshot.version, position, hash);
    }
  }

  async record(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    for (const draft of drafts) {
      const db = await this.open(sessionId, draft.entry.item.id);
      try {
        db.transaction(() => {
          if (
            draft.mutationId !== undefined &&
            db.query('INSERT OR IGNORE INTO mutations VALUES (?)').run(draft.mutationId).changes === 0
          )
            return;
          let latest =
            db.query<{ latest: number }, []>('SELECT COALESCE(MAX(version), 0) AS latest FROM versions').get()
              ?.latest ?? 0;
          if (latest === 0 && draft.before !== undefined) {
            this.save(
              db,
              AgendaVersionSchema.parse({
                version: ++latest,
                at: draft.before.item.waitingSince,
                by: 'ferret',
                change: CARRIED_VERSION,
                lifecycle: draft.before.lifecycle,
                item: draft.before.item,
              }),
              draft.beforeConversation,
            );
          }
          this.save(
            db,
            AgendaVersionSchema.parse({
              version: ++latest,
              at: draft.at,
              by: draft.by,
              change: draft.change,
              lifecycle: draft.entry.lifecycle,
              item: draft.entry.item,
            }),
            draft.conversation,
          );
        })();
      } finally {
        db.close();
      }
    }
  }

  async discard(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    this.cached = undefined;
    // Latest first: an intent's drafts for one item are its tail, so each peels the one before it.
    for (const draft of [...drafts].reverse()) {
      if (draft.mutationId === undefined) continue;
      const db = await this.openExisting(sessionId, draft.entry.item.id);
      if (db === undefined) continue;
      try {
        db.transaction(() => {
          if (db.query('DELETE FROM mutations WHERE id = ?').run(draft.mutationId ?? '').changes === 0) return;
          const tail = db
            .query<{ version: number; summary: string }, []>(
              'SELECT version, summary FROM versions ORDER BY version DESC LIMIT 1',
            )
            .get();
          const summary = tail === null ? undefined : AgendaVersionSummarySchema.parse(JSON.parse(tail.summary));
          if (tail === null || summary?.at !== draft.at || summary.change !== draft.change) return;
          db.query('DELETE FROM version_words WHERE version = ?').run(tail.version);
          db.query('DELETE FROM versions WHERE version = ?').run(tail.version);
        })();
      } finally {
        db.close();
      }
    }
  }

  async list(sessionId: string, id: AgendaId): Promise<readonly AgendaVersionSummary[]> {
    const db = await this.openExisting(sessionId, id);
    if (db === undefined) return [];
    try {
      return db
        .query<{ summary: string }, []>('SELECT summary FROM versions ORDER BY version')
        .all()
        .map(row => AgendaVersionSummarySchema.parse(JSON.parse(row.summary)));
    } finally {
      db.close();
    }
  }

  private async load(sessionId: string, id: AgendaId, version: number): Promise<CachedVersion | undefined> {
    const key = `${this.file(sessionId, id)}:${version}`;
    if (this.cached?.key === key) return this.cached;
    const db = await this.openExisting(sessionId, id);
    if (db === undefined) return undefined;
    try {
      const row = db
        .query<{ snapshot: string }, [number]>('SELECT snapshot FROM versions WHERE version = ?')
        .get(version);
      if (row === null) return undefined;
      const snapshot = deepFreezeJson(
        AgendaVersionSchema.parse(JSON.parse(row.snapshot)) as unknown as JsonValue,
      ) as unknown as AgendaVersion;
      const found = { key, snapshot };
      this.cached = found;
      return found;
    } finally {
      db.close();
    }
  }

  async get(sessionId: string, id: AgendaId, version: number): Promise<AgendaVersion | undefined> {
    return (await this.load(sessionId, id, version))?.snapshot;
  }

  async conversation(
    sessionId: string,
    id: AgendaId,
    version: number,
  ): Promise<readonly AgendaConversationEntry[] | undefined> {
    const found = await this.load(sessionId, id, version);
    if (found === undefined) return undefined;
    if (found.conversation !== undefined) return found.conversation;
    const db = await this.openExisting(sessionId, id);
    if (db === undefined) return undefined;
    try {
      const rows = db
        .query<{ entry: string }, [number]>(
          `
        SELECT words.entry FROM version_words JOIN words ON words.hash = version_words.hash
        WHERE version_words.version = ? ORDER BY version_words.position
      `,
        )
        .all(version);
      found.conversation = deepFreezeJson(
        rows.map(row => AgendaConversationEntrySchema.parse(JSON.parse(row.entry))) as unknown as JsonValue,
      ) as unknown as readonly AgendaConversationEntry[];
      return found.conversation;
    } finally {
      db.close();
    }
  }
}
