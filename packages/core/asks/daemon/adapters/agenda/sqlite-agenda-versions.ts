import type { SqliteHandle, StatePort } from '@ferretry/kernel/contract';
import { deepFreezeJson, type JsonValue } from '@ferretry/std';
import { createHash } from 'node:crypto';
import { AskVersionsFiles } from '../../../contract/index.ts';
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
import {
  type AgendaVersionDraft,
  type AgendaVersionStore,
  CARRIED_VERSION,
  isAgendaSessionId,
} from '../../lib/agenda/index.ts';
import { versionArchiveName } from '../../lib/state.ts';

const tablesIn = (db: SqliteHandle): number =>
  db.query<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")[0]?.n ?? 0;

/** Words per INSERT: far under SQLite's limit of bound values per statement, and large enough to be a handful of calls. */
const WORDS_PER_STATEMENT = 200;

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
 * `state/asks/versions/<ferret>~<id>.sqlite`: complete bounded snapshots indexed by version, immutable words keyed by
 * SHA-256, and per-version ordered word references. Appends inspect only the largest primary key, never historical
 * payloads. SQLite commits a version and all its references together; an interrupted append cannot publish half a
 * version. The caller serializes writes per session. Connections close after each operation; at most one read version
 * is cached. The kernel opens each one at format 1 (`PRAGMA user_version`) and refuses any other, never upgrading or
 * emptying it; the tables are built only in a file that holds none.
 *
 * Each draft is its own archive file (create, WAL, commit, checkpoint on close: tens of milliseconds of synchronous
 * disk work), so `record` gives the event loop a turn between drafts: a ledger of a few hundred drafts held the whole
 * daemon for 3.99 s on a real-size home when it did not. A single archive is still one synchronous write, so its words
 * go in a few multi-row statements.
 */
export class SqliteAgendaVersionStore implements AgendaVersionStore {
  private cached: CachedVersion | undefined;

  /**
   * `yieldToLoop` gives whatever waits on the event loop (a request, a stream, a timer) a turn; the daemon passes the
   * kernel clock's, so the default does not yield (a test with a virtual clock must not wait on a real one).
   */
  constructor(
    private readonly state: Pick<StatePort, 'sqlite' | 'list'>,
    private readonly yieldToLoop: () => Promise<void> = async () => undefined,
  ) {}

  private name(sessionId: string, id: AgendaId): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    if (!AgendaIdSchema.safeParse(id).success) throw new Error(`not a valid agenda id: ${id}`);
    return versionArchiveName(sessionId, id);
  }

  /** A read opens only what a record created: an id nothing was recorded for has no store, and asking never makes one. */
  private async openExisting(sessionId: string, id: AgendaId): Promise<SqliteHandle | undefined> {
    const name = this.name(sessionId, id);
    return (await this.state.list(AskVersionsFiles)).includes(name) ? this.open(sessionId, id) : undefined;
  }

  private open(sessionId: string, id: AgendaId): SqliteHandle {
    const db = this.state.sqlite(AskVersionsFiles, this.name(sessionId, id));
    try {
      if (tablesIn(db) > 0) return db;
      db.transaction(() => {
        if (tablesIn(db) > 0) return;
        db.run('CREATE TABLE mutations (id TEXT PRIMARY KEY) WITHOUT ROWID');
        db.run('CREATE TABLE versions (version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, summary TEXT NOT NULL)');
        db.run('CREATE TABLE words (hash TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID');
        db.run(
          'CREATE TABLE version_words (version INTEGER NOT NULL, position INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (version, position)) WITHOUT ROWID',
        );
      });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private save(db: SqliteHandle, snapshot: AgendaVersion, conversation?: readonly AgendaConversationEntry[]): void {
    const inserted = db.run('INSERT OR IGNORE INTO versions VALUES (?, ?, ?)', [
      snapshot.version,
      JSON.stringify(snapshot),
      JSON.stringify(summaryOf(snapshot)),
    ]);
    if (inserted.changes === 0) return;
    const words = (conversation ?? snapshot.item.conversation ?? []).map(entry => {
      const text = JSON.stringify(AgendaConversationEntrySchema.parse(entry));
      return { text, hash: createHash('sha256').update(text).digest('hex') };
    });
    // A few multi-row statements, not two per word: a thread of thousands of words is a few calls into SQLite.
    for (let from = 0; from < words.length; from += WORDS_PER_STATEMENT) {
      const chunk = words.slice(from, from + WORDS_PER_STATEMENT);
      db.run(
        `INSERT OR IGNORE INTO words VALUES ${chunk.map(() => '(?, ?)').join(', ')}`,
        chunk.flatMap(word => [word.hash, word.text]),
      );
      db.run(
        `INSERT INTO version_words VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
        chunk.flatMap((word, offset) => [snapshot.version, from + offset, word.hash]),
      );
    }
  }

  async record(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    for (const [index, draft] of drafts.entries()) {
      if (index > 0) await this.yieldToLoop();
      const db = this.open(sessionId, draft.entry.item.id);
      try {
        db.transaction(() => {
          if (
            draft.mutationId !== undefined &&
            db.run('INSERT OR IGNORE INTO mutations VALUES (?)', [draft.mutationId]).changes === 0
          )
            return;
          let latest =
            db.query<{ latest: number }>('SELECT COALESCE(MAX(version), 0) AS latest FROM versions')[0]?.latest ?? 0;
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
        });
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
          if (db.run('DELETE FROM mutations WHERE id = ?', [draft.mutationId ?? '']).changes === 0) return;
          const [tail] = db.query<{ version: number; summary: string }>(
            'SELECT version, summary FROM versions ORDER BY version DESC LIMIT 1',
          );
          const summary = tail === undefined ? undefined : AgendaVersionSummarySchema.parse(JSON.parse(tail.summary));
          if (tail === undefined || summary?.at !== draft.at || summary.change !== draft.change) return;
          db.run('DELETE FROM version_words WHERE version = ?', [tail.version]);
          db.run('DELETE FROM versions WHERE version = ?', [tail.version]);
        });
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
        .query<{ summary: string }>('SELECT summary FROM versions ORDER BY version')
        .map(row => AgendaVersionSummarySchema.parse(JSON.parse(row.summary)));
    } finally {
      db.close();
    }
  }

  private async load(sessionId: string, id: AgendaId, version: number): Promise<CachedVersion | undefined> {
    const key = `${this.name(sessionId, id)}:${version}`;
    if (this.cached?.key === key) return this.cached;
    const db = await this.openExisting(sessionId, id);
    if (db === undefined) return undefined;
    try {
      const [row] = db.query<{ snapshot: string }>('SELECT snapshot FROM versions WHERE version = ?', [version]);
      if (row === undefined) return undefined;
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
      const rows = db.query<{ entry: string }>(
        'SELECT words.entry FROM version_words JOIN words ON words.hash = version_words.hash WHERE version_words.version = ? ORDER BY version_words.position',
        [version],
      );
      found.conversation = deepFreezeJson(
        rows.map(row => AgendaConversationEntrySchema.parse(JSON.parse(row.entry))) as unknown as JsonValue,
      ) as unknown as readonly AgendaConversationEntry[];
      return found.conversation;
    } finally {
      db.close();
    }
  }
}
