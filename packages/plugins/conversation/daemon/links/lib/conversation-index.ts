import { createHash } from 'node:crypto';
import {
  HARNESS_HISTORY_READ_MAX_BYTES,
  type HarnessHistoryFiles,
  type HarnessHistoryKind,
} from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { SqliteHandle } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_NAME_MAX, CONVERSATION_PREVIEW_MAX, type LinkableConversation } from '../../../contract/index.ts';
import type { TranscriptEvent, TranscriptHarness } from '../../reader/lib/transcript/types.ts';
import { describeConversation, type DescribedConversation } from './conversation-describer.ts';
import { isOwnerMessage } from '../../reader/lib/transcript/owner.ts';
import { codexIndexNames, transcriptNames } from './conversation-name.ts';
import { spokenMessages, truncateText, writtenMessages } from './conversation-text.ts';

/**
 * THE CONVERSATION INDEX (shared-history design §3.3): one row per transcript file of every history Conversation lists,
 * kept current by an incremental updater, so a listing is one indexed query instead of a read of every transcript.
 *
 * Read-only on transcripts by construction: the only handle on a transcript is {@link HarnessHistoryFiles}, which has
 * no write. The index file itself is a cache (`sqlite-cache`): a layout it does not recognise is dropped and rebuilt.
 *
 * What a file costs the updater:
 *   unchanged (size and mtime the same)       nothing — a stat that the directory listing already made
 *   grew, same first 4 KiB                    only the bytes after the last record already read
 *   new, rewritten, or grew with a new head   its first {@link HEAD_READ_BYTES} and last {@link TAIL_READ_BYTES}, never the
 *                                             whole file, and its turn count is a floor when the middle was skipped
 *   gone                                      its row is dropped
 */

/** How much of a new or rewritten transcript is read from its start: the folder, the first message, the first names. */
const HEAD_READ_BYTES = 256 * 1024;
/** And from its end: the latest message, the model, the last activity, the latest names. */
const TAIL_READ_BYTES = 1024 * 1024;
/**
 * The end is read in two steps: this much first, which holds the latest message of nearly every conversation, and the full
 * {@link TAIL_READ_BYTES} only when it holds none (a long run of tool work). Parsing is what a cold build costs, so a tail
 * that is nearly always enough is read at a quarter of the price.
 */
const TAIL_NARROW_BYTES = 256 * 1024;
/** A head that holds no message (a first record carrying a huge paste) is read this far instead, once. */
const HEAD_WIDE_READ_BYTES = 4 * 1024 * 1024;
/** What the first-bytes hash covers. */
const HASH_BYTES = 4096;
/** The largest appended run read as a delta; more than this is re-read from its two ends instead. */
const DELTA_READ_MAX_BYTES = 4 * 1024 * 1024;
/** A refresh newer than this is reused by a listing. */
const INDEX_FRESH_MS = 5_000;
/** The longest a listing waits for a refresh of an already built index before it answers with what it has. */
const INDEX_WAIT_MS = 250;
/** Files described at once: reads overlap, parses and writes take turns. */
const CONCURRENCY = 8;
/** Rows written per transaction. */
const BATCH_ROWS = 64;
/** The most levels of folders below a Codex `sessions` (`YYYY/MM/DD`, with room). */
const CODEX_MAX_DEPTH = 4;
/** Folders listed at once in a walk: listing is waiting on the disk, so several at a time cost one wait. */
const WALK_CONCURRENCY = 16;
const CODEX_INDEX = 'session_index.jsonl';
const CODEX_INDEX_READ_MAX_BYTES = 1024 * 1024;
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
/** Bump when a column or what a column holds changes: the cache is dropped and rebuilt. */
const LAYOUT = '1';
const NAME_FALLBACK_MAX = 60;

/** One tree of transcripts the index reads: which harness wrote it, what parses it, and the read-only view of it. */
export interface IndexSource {
  /** The harness plugin's key (`claude-code`, `codex`). */
  readonly harness: string;
  readonly parser: TranscriptHarness;
  readonly kind: HarnessHistoryKind;
  readonly label: string;
  readonly files: HarnessHistoryFiles;
}

/** The ferret that runs, or ran, a harness conversation, by `"<harness>:<conversation id>"`. */
export type FerretConversationNames = ReadonlyMap<string, { readonly ferret: string; readonly name: string }>;

/** What the index needs of a parser: a text in, its events out. Where the parse runs (and how it paces itself) is the caller's. */
export interface IndexParser {
  parse(input: {
    readonly text: string;
    readonly source: string;
    readonly endOfInput: true;
  }): Promise<{ readonly events: readonly TranscriptEvent[] }>;
}

export interface ConversationIndexNeeds {
  readonly sqlite: () => SqliteHandle;
  readonly sources: () => Promise<readonly IndexSource[]>;
  readonly ferretNames: () => Promise<FerretConversationNames>;
  readonly parsers: Readonly<Record<TranscriptHarness, IndexParser>>;
  readonly nowMs: () => number;
  /** Waits `ms`. Absent: a listing waits for its refresh to finish, however long (a test). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly yieldToLoop?: () => Promise<void>;
  readonly warn?: (message: string) => void;
}

/** A row as the index holds it. */
interface Row {
  readonly harness: string;
  readonly kind: HarnessHistoryKind;
  readonly label: string;
  readonly path: string;
  readonly id: string;
  readonly size: number;
  readonly mtime_ms: number;
  readonly scanned: number;
  readonly head_sha: string;
  readonly ok: number;
  readonly project: string;
  readonly file_title: string | null;
  readonly index_title: string | null;
  readonly title: string | null;
  readonly ferret_id: string | null;
  readonly ferret_name: string | null;
  readonly preview: string;
  readonly latest: string | null;
  readonly first_at: number;
  readonly last_at: number;
  readonly turns: number;
  readonly turns_at_least: number;
  readonly model: string | null;
  readonly hay: string;
  /** Described by its hand-off pointer lines as written, because every message it holds is one. */
  readonly written: number;
}

type RowInput = Omit<Row, 'hay' | 'title' | 'written'> & {
  readonly written?: number | undefined;
  readonly hay?: string | undefined;
  readonly title?: string | null | undefined;
};

/** What the walk compares a file against, without loading the row. */
interface Stamp {
  readonly path: string;
  readonly size: number;
  readonly mtime_ms: number;
}

/** What a listing asks the index for. `words` are lower-case already. */
export interface IndexQuery {
  readonly harness?: string | undefined;
  /** Only these kinds (and the newest copy among them wins). Absent: all. */
  readonly kinds?: readonly HarnessHistoryKind[] | undefined;
  readonly words?: readonly string[] | undefined;
  readonly sinceMs?: number | undefined;
  readonly limit?: number | undefined;
}

/** A conversation as the index answers it: the wire fields, and where its file is. */
export interface IndexedConversation {
  /** The wire row; its `harness` is the harness plugin's key. */
  readonly row: LinkableConversation;
  readonly harness: string;
  readonly kind: HarnessHistoryKind;
  readonly label: string;
  readonly path: string;
  readonly parser: TranscriptHarness;
}

export interface IndexAnswer {
  readonly conversations: readonly IndexedConversation[];
  readonly matched: number;
  readonly skipped: number;
}

/** The text a search word is looked for in, lower-cased as the matcher always did. */
const hayOf = (parts: {
  readonly ferretName?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly preview: string;
  readonly latest?: string | null | undefined;
  readonly project: string;
}): string =>
  [parts.ferretName ?? '', parts.title ?? '', parts.preview, parts.latest ?? '', parts.project]
    .join('\n')
    .toLowerCase();

const sha = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);
const sourceKeyOf = (source: { harness: string; kind: string; label: string }): string =>
  `${source.harness}\u0000${source.kind}\u0000${source.label}`;

/** `work` over every item, at most `limit` at a time. */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) await work(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Where the last complete record of `bytes` ends (just past its last newline), or `0`. */
function lastRecordEnd(bytes: Uint8Array): number {
  const at = bytes.lastIndexOf(0x0a);
  return at < 0 ? 0 : at + 1;
}

/** The last instant of `events`, and the model they last name. */
function activity(events: readonly TranscriptEvent[]): { first?: number; last?: number; model?: string } {
  let first: number | undefined;
  let last: number | undefined;
  let model: string | undefined;
  for (const event of events) {
    if (event.kind === 'usage' && event.usage.model !== undefined) model = event.usage.model;
    if (event.kind === 'settings' && event.settings.model !== undefined) model = event.settings.model;
    const at = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    if (first === undefined || at < first) first = at;
    if (last === undefined || at > last) last = at;
  }
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    ...(model === undefined ? {} : { model }),
  };
}

/** A file the walk found: its place in its tree, and what the listing that found it said about it. */
interface Found {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly nameId: string;
}

interface Work {
  readonly source: IndexSource;
  readonly found: Found;
  readonly old: Row | undefined;
}

export class ConversationIndex {
  #db: SqliteHandle | undefined;
  #running: Promise<void> | undefined;
  /** Rows were written or dropped since the winners were last settled. */
  #changed = false;
  #lastDoneMs: number | undefined;
  #sources: ReadonlyMap<string, IndexSource> = new Map();

  constructor(private readonly needs: ConversationIndexNeeds) {}

  // ─── storage ──────────────────────────────────────────────────────────────────────────────────────────────────

  #open(): SqliteHandle {
    if (this.#db !== undefined) return this.#db;
    const db = this.needs.sqlite();
    db.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const layout = db.query<{ v: string }>("SELECT v FROM meta WHERE k = 'layout'")[0]?.v;
    if (layout !== LAYOUT) {
      db.run('DROP TABLE IF EXISTS conv');
      db.run('DROP TABLE IF EXISTS index_names');
      db.run('DELETE FROM meta');
    }
    db.run(`CREATE TABLE IF NOT EXISTS conv (
      harness TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, path TEXT NOT NULL, id TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, scanned INTEGER NOT NULL, head_sha TEXT NOT NULL, ok INTEGER NOT NULL,
      project TEXT NOT NULL, file_title TEXT, index_title TEXT, title TEXT, ferret_id TEXT, ferret_name TEXT,
      preview TEXT NOT NULL, latest TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      turns INTEGER NOT NULL, turns_at_least INTEGER NOT NULL, model TEXT, hay TEXT NOT NULL,
      win INTEGER NOT NULL DEFAULT 1, written INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (harness, kind, label, path)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS conv_by_id ON conv (harness, id)');
    db.run('CREATE INDEX IF NOT EXISTS conv_by_last ON conv (last_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS conv_by_win ON conv (win, last_at DESC)');
    db.run(
      'CREATE TABLE IF NOT EXISTS index_names (source TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (source, id))',
    );
    db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('layout', ?)", [LAYOUT]);
    this.#db = db;
    return db;
  }

  /** Whether a full build has completed at least once, here or in an earlier run: a listing waits for none before that. */
  get built(): boolean {
    return this.#open().query<{ v: string }>("SELECT v FROM meta WHERE k = 'built'")[0]?.v === '1';
  }

  /** Whether an update is running now. */
  get refreshing(): boolean {
    return this.#running !== undefined;
  }

  get rowCount(): number {
    return this.#open().query<{ n: number }>('SELECT count(*) AS n FROM conv')[0]?.n ?? 0;
  }

  #write(rows: readonly RowInput[]): void {
    if (rows.length === 0) return;
    this.#changed = true;
    const db = this.#open();
    db.transaction(() => {
      for (const input of rows) {
        const title = input.title ?? input.index_title ?? input.file_title;
        const hay =
          input.hay ??
          hayOf({
            ferretName: input.ferret_name,
            title,
            preview: input.preview,
            latest: input.latest,
            project: input.project,
          });
        db.run(
          `INSERT OR REPLACE INTO conv (harness, kind, label, path, id, size, mtime_ms, scanned, head_sha, ok, project, file_title,
             index_title, title, ferret_id, ferret_name, preview, latest, first_at, last_at, turns, turns_at_least, model, hay, written)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.harness,
            input.kind,
            input.label,
            input.path,
            input.id,
            input.size,
            input.mtime_ms,
            input.scanned,
            input.head_sha,
            input.ok,
            input.project,
            input.file_title,
            input.index_title,
            title,
            input.ferret_id,
            input.ferret_name,
            input.preview,
            input.latest,
            input.first_at,
            input.last_at,
            input.turns,
            input.turns_at_least,
            input.model,
            hay,
            input.written ?? 0,
          ],
        );
      }
    });
  }

  // ─── refresh ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Starts an update unless one is running; resolves when it ends (never rejects). */
  refresh(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const run = this.#refreshNow()
      .catch((error: unknown) => {
        this.needs.warn?.(
          `The conversation index could not be updated: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.#running = undefined;
        this.#lastDoneMs = this.needs.nowMs();
      });
    this.#running = run;
    return run;
  }

  /**
   * What a listing does first. A built index that is older than {@link INDEX_FRESH_MS} is refreshed and waited for, up to
   * {@link INDEX_WAIT_MS}; an index never built is never waited for. Resolves with whether the answer will be partial
   * (an update is still running).
   */
  async ready(): Promise<{ readonly indexing: boolean }> {
    const stale = this.#lastDoneMs === undefined || this.needs.nowMs() - this.#lastDoneMs >= INDEX_FRESH_MS;
    if (stale || this.#running !== undefined) {
      const run = this.refresh();
      if (this.built) {
        const sleep = this.needs.sleep;
        await (sleep === undefined ? run : Promise.race([run, sleep(INDEX_WAIT_MS)]));
      }
    }
    return { indexing: this.#running !== undefined };
  }

  async #refreshNow(): Promise<void> {
    const db = this.#open();
    const sources = await this.needs.sources();
    this.#sources = new Map(sources.map(source => [sourceKeyOf(source), source]));
    const present = new Set(this.#sources.keys());
    const harnesses = new Set(sources.map(source => source.harness));

    // A source that is no longer there (a ferret deleted, a home that became a link) takes its rows with it. Only a harness
    // that answered at all is judged: one that is off hides its history, it does not empty it.
    for (const stale of db.query<{ harness: string; kind: string; label: string }>(
      'SELECT DISTINCT harness, kind, label FROM conv',
    )) {
      if (harnesses.has(stale.harness) && !present.has(sourceKeyOf(stale))) {
        this.#changed = true;
        db.run('DELETE FROM conv WHERE harness = ? AND kind = ? AND label = ?', [
          stale.harness,
          stale.kind,
          stale.label,
        ]);
      }
    }

    const work: Work[] = [];
    // Every tree is walked at once: the walk waits on the disk, and each tree is a different part of it.
    const walked = await Promise.all(sources.map(async source => ({ source, listed: await this.#walk(source) })));
    for (const { source, listed } of walked) {
      const existing = new Map<string, Stamp>();
      for (const row of db.query<Stamp>(
        'SELECT path, size, mtime_ms FROM conv WHERE harness = ? AND kind = ? AND label = ?',
        [source.harness, source.kind, source.label],
      ))
        existing.set(row.path, row);
      const seen = new Set<string>();
      for (const found of listed) {
        seen.add(found.path);
        const old = existing.get(found.path);
        if (old !== undefined && old.size === found.size && old.mtime_ms === found.mtimeMs) continue;
        work.push({
          source,
          found,
          old:
            old === undefined
              ? undefined
              : db.query<Row>('SELECT * FROM conv WHERE harness = ? AND kind = ? AND label = ? AND path = ?', [
                  source.harness,
                  source.kind,
                  source.label,
                  found.path,
                ])[0],
        });
      }
      for (const [path] of existing)
        if (!seen.has(path)) {
          this.#changed = true;
          db.run('DELETE FROM conv WHERE harness = ? AND kind = ? AND label = ? AND path = ?', [
            source.harness,
            source.kind,
            source.label,
            path,
          ]);
        }
    }
    // Codex's thread names first, so a row described below already carries its name.
    for (const source of sources) await this.#codexNames(source);

    // Newest first, so a listing during a cold build shows the conversations people are most likely to want.
    work.sort((a, b) => b.found.mtimeMs - a.found.mtimeMs);
    await this.#run(work);
    await this.#applyFerretNames();
    this.#settleWinners();
    db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('built', '1')");
  }

  /** Every transcript file of one tree, from directory listings alone: no file is opened. */
  async #walk(source: IndexSource): Promise<readonly Found[]> {
    const found: Found[] = [];
    const { files } = source;
    if (source.parser === 'claude') {
      const projects = (await files.entries('projects')).filter(project => project.kind === 'directory');
      await inParallel(projects, WALK_CONCURRENCY, async project => {
        for (const entry of await files.entries(`projects/${project.name}`)) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
          found.push({
            path: `projects/${project.name}/${entry.name}`,
            size: entry.size,
            mtimeMs: entry.modifiedMs,
            nameId: entry.name.slice(0, -'.jsonl'.length),
          });
        }
      });
      return found;
    }
    // Level by level, the folders of one level listed together.
    let level: readonly string[] = ['sessions'];
    for (let depth = 0; level.length > 0; depth += 1) {
      const next: string[] = [];
      await inParallel(level, WALK_CONCURRENCY, async directory => {
        for (const entry of await files.entries(directory)) {
          const path = `${directory}/${entry.name}`;
          if (entry.kind === 'directory') {
            if (depth < CODEX_MAX_DEPTH) next.push(path);
          } else if (entry.kind === 'file' && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
            const id = ROLLOUT_ID.exec(entry.name)?.[1];
            if (id !== undefined) found.push({ path, size: entry.size, mtimeMs: entry.modifiedMs, nameId: id });
          }
        }
      });
      level = next;
    }
    return found;
  }

  async #run(work: readonly Work[]): Promise<void> {
    let next = 0;
    const pending: RowInput[] = [];
    const flush = (): void => {
      this.#write(pending.splice(0));
    };
    const worker = async (): Promise<void> => {
      for (let index = next++; index < work.length; index = next++) {
        const item = work[index] as Work;
        const row = await this.#describe(item).catch((error: unknown): RowInput | undefined => {
          this.needs.warn?.(
            `A transcript could not be indexed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
        if (row !== undefined) pending.push(row);
        if (pending.length >= BATCH_ROWS) flush();
        await this.needs.yieldToLoop?.();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
    flush();
  }

  // ─── describing one file ──────────────────────────────────────────────────────────────────────────────────────

  async #describe({ source, found, old }: Work): Promise<RowInput | undefined> {
    const base = { harness: source.harness, kind: source.kind, label: source.label, path: found.path };
    // Grew with the same beginning: only what was appended is read.
    if (
      old !== undefined &&
      old.ok === 1 &&
      old.scanned > 0 &&
      found.size > old.size &&
      found.size - old.scanned <= DELTA_READ_MAX_BYTES
    ) {
      const delta = await this.#delta(source, found, old);
      if (delta !== undefined) return delta;
    }
    // Narrow tail first; the full tail only when the narrow one holds no message the owner said; a wide head only when
    // the head holds none (a first record carrying a large paste).
    // Claude's end almost always holds a message the owner said; Codex's rarely does (its rollouts are mostly tool and
    // token records), so it reads its full end at once instead of reading twice.
    let read = await this.#bounded(
      source.files,
      found.path,
      found.size,
      HEAD_READ_BYTES,
      source.parser === 'claude' ? TAIL_NARROW_BYTES : TAIL_READ_BYTES,
    );
    if (read === undefined) return undefined;
    let result = await this.#describeText(source, found, read);
    if (result !== undefined && read.partial && !result.tailSpoke) {
      const fuller = await this.#bounded(source.files, found.path, found.size, HEAD_READ_BYTES, TAIL_READ_BYTES);
      if (fuller !== undefined) {
        read = fuller;
        result = await this.#describeText(source, found, fuller);
      }
    }
    // A head holding no message at all (as opposed to messages that say nothing: a hand-off pointer, a reminder) was cut
    // through a large first record, so look once at the first 4 MiB. A conversation that is only pointers stays unlisted.
    if (result === undefined && read.partial && read.headOwner === false) {
      const wide = await this.#bounded(source.files, found.path, found.size, HEAD_WIDE_READ_BYTES, TAIL_READ_BYTES);
      if (wide !== undefined) {
        read = wide;
        result = await this.#describeText(source, found, wide);
      }
    }
    const used = read;
    const common = {
      ...base,
      size: found.size,
      mtime_ms: found.mtimeMs,
      scanned: used.scanned,
      head_sha: used.headSha,
      ferret_id: old?.ferret_id ?? null,
      ferret_name: old?.ferret_name ?? null,
      index_title: this.#indexTitle(source, found.nameId),
    };
    if (result === undefined)
      // Describes no conversation (no message the owner said, or no folder): remembered so an unchanged file is not read again,
      // and counted as one the listing could not read.
      return {
        ...common,
        id: found.nameId,
        ok: 0,
        project: '',
        file_title: null,
        preview: '',
        latest: null,
        first_at: 0,
        last_at: found.mtimeMs,
        turns: 0,
        turns_at_least: 0,
        model: null,
      };
    return {
      ...common,
      id: result.row.id,
      ok: 1,
      project: result.row.project,
      file_title: result.row.name ?? null,
      preview: result.row.preview,
      latest: result.row.latest ?? null,
      first_at: result.firstAt ?? Date.parse(result.row.lastActivityAt),
      last_at: Date.parse(result.row.lastActivityAt),
      turns: result.row.turns,
      turns_at_least: result.row.turnsAtLeast === true ? 1 : 0,
      model: result.row.model ?? null,
      written: result.written ? 1 : 0,
    };
  }

  /**
   * A file read from its two ends. `scanned` is where the next delta starts: just past the last complete record read.
   * `partial` says the middle was not read.
   */
  async #bounded(
    files: HarnessHistoryFiles,
    path: string,
    size: number,
    headMax: number,
    tailMax: number,
  ): Promise<Bounded | undefined> {
    const whole = size <= Math.min(headMax + tailMax, HARNESS_HISTORY_READ_MAX_BYTES);
    if (whole) {
      const bytes = await files.read(path, 0, size);
      if (bytes === undefined) return undefined;
      return {
        text: decode(bytes),
        headText: undefined,
        tailText: undefined,
        partial: false,
        scanned: lastRecordEnd(bytes),
        headSha: sha(bytes.subarray(0, Math.min(HASH_BYTES, bytes.length))),
      };
    }
    const tailStart = Math.max(size - tailMax, headMax);
    const [head, tail] = await Promise.all([
      files.read(path, 0, headMax),
      files.read(path, tailStart, size - tailStart),
    ]);
    if (head === undefined || tail === undefined) return undefined;
    // Each end is cut to whole records: the head's last line and the tail's first are pieces of ones the read cut through.
    const headText = decode(head);
    const tailText = decode(tail);
    const start = tailText.indexOf('\n');
    const headCut = headText.slice(0, headText.lastIndexOf('\n') + 1);
    const tailCut = start < 0 ? '' : tailText.slice(start + 1);
    return {
      text: `${headCut}${tailCut}`,
      headText: headCut,
      tailText: tailCut,
      partial: true,
      scanned: tailStart + lastRecordEnd(tail),
      headSha: sha(head.subarray(0, Math.min(HASH_BYTES, head.length))),
    };
  }

  async #describeText(
    source: IndexSource,
    found: Found,
    read: Bounded,
  ): Promise<
    | {
        readonly row: DescribedConversation;
        readonly firstAt: number | undefined;
        readonly tailSpoke: boolean;
        readonly written: boolean;
      }
    | undefined
  > {
    const parser = this.needs.parsers[source.parser];
    // The two ends of a big file are parsed on their own, so it is known whether the end held anything the owner said.
    let events: readonly TranscriptEvent[];
    let tailSpoke = true;
    if (read.headText !== undefined && read.tailText !== undefined) {
      const head = (await parser.parse({ text: read.headText, source: found.path, endOfInput: true })).events;
      const tail = (await parser.parse({ text: read.tailText, source: found.path, endOfInput: true })).events;
      tailSpoke = spokenMessages(tail).length > 0;
      read.headOwner = head.some(isOwnerMessage);
      events = [...head, ...tail];
    } else {
      events = (await parser.parse({ text: read.text, source: found.path, endOfInput: true })).events;
    }
    const row = describeConversation(
      { harness: source.parser, nameId: found.nameId },
      read.text,
      events,
      found.mtimeMs,
      undefined,
      read.partial,
      true,
    );
    return row === undefined
      ? undefined
      : { row, firstAt: activity(events).first, tailSpoke, written: spokenMessages(events).length === 0 };
  }

  /** Folds what was appended since the last read into the row: latest message, last activity, turns, model. */
  async #delta(source: IndexSource, found: Found, old: Row): Promise<RowInput | undefined> {
    const head = await source.files.read(found.path, 0, Math.min(HASH_BYTES, old.size));
    if (head === undefined || sha(head) !== old.head_sha) return undefined;
    const bytes = await source.files.read(found.path, old.scanned, found.size - old.scanned);
    if (bytes === undefined) return undefined;
    const complete = lastRecordEnd(bytes);
    const text = decode(bytes.subarray(0, complete));
    // A rename (or a new generated title) changes the name, and the name's wrapper rule needs the whole conversation: re-read.
    const names = transcriptNames(source.parser, text);
    if (names.chosen !== undefined || names.generated !== undefined) return undefined;
    const { events } = await this.needs.parsers[source.parser].parse({ text, source: found.path, endOfInput: true });
    const spoken = old.written === 1 ? writtenMessages(events) : spokenMessages(events);
    const seen = activity(events);
    const latest = spoken.at(-1)?.slice(0, CONVERSATION_PREVIEW_MAX);
    return {
      harness: source.harness,
      kind: source.kind,
      label: source.label,
      path: found.path,
      id: old.id,
      size: found.size,
      mtime_ms: found.mtimeMs,
      scanned: old.scanned + complete,
      head_sha: old.head_sha,
      ok: 1,
      project: old.project,
      file_title: old.file_title,
      index_title: old.index_title,
      ferret_id: old.ferret_id,
      ferret_name: old.ferret_name,
      preview: old.preview,
      latest: latest === undefined ? old.latest : latest === old.preview ? null : latest,
      first_at: old.first_at,
      last_at: seen.last === undefined ? Math.max(old.last_at, found.mtimeMs) : Math.max(old.last_at, seen.last),
      turns: old.turns + spoken.length,
      turns_at_least: old.turns_at_least,
      model: seen.model ?? old.model,
      written: old.written,
    };
  }

  // ─── names ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Marks, for each conversation held in more than one place, the newest copy (`win`): the one a listing shows. Settled once
   * per update that changed anything, so a query reads a flag instead of comparing every row with its copies.
   */
  #settleWinners(): void {
    if (!this.#changed) return;
    this.#open().run(
      `UPDATE conv SET win = CASE WHEN ok = 1 AND NOT EXISTS (SELECT 1 FROM conv d WHERE d.harness = conv.harness AND d.id = conv.id
         AND d.ok = 1 AND d.rowid <> conv.rowid AND (d.last_at > conv.last_at OR (d.last_at = conv.last_at AND d.rowid < conv.rowid)))
         THEN 1 ELSE 0 END`,
    );
    this.#changed = false;
  }

  /** Codex's own name for each thread (its `session_index.jsonl`), which wins over the one a rollout recorded. */
  async #codexNames(source: IndexSource): Promise<void> {
    if (source.parser !== 'codex') return;
    const db = this.#open();
    const key = sourceKeyOf(source);
    const stat = await source.files.stat(CODEX_INDEX);
    const stamp = stat === undefined ? 'none' : `${stat.size}:${stat.modifiedMs}`;
    const marker = `names:${key}`;
    if (db.query<{ v: string }>('SELECT v FROM meta WHERE k = ?', [marker])[0]?.v === stamp) return;
    let names: ReadonlyMap<string, string> = new Map();
    if (stat !== undefined) {
      const bytes = await source.files.read(
        CODEX_INDEX,
        Math.max(0, stat.size - CODEX_INDEX_READ_MAX_BYTES),
        CODEX_INDEX_READ_MAX_BYTES,
      );
      if (bytes === undefined) return;
      const text = decode(bytes);
      names = codexIndexNames(stat.size > CODEX_INDEX_READ_MAX_BYTES ? text.slice(text.indexOf('\n') + 1) : text);
    }
    const before = new Map(
      db
        .query<{ id: string; name: string }>('SELECT id, name FROM index_names WHERE source = ?', [key])
        .map(row => [row.id, row.name]),
    );
    const changed = new Set<string>();
    for (const [id, name] of names) if (before.get(id) !== name) changed.add(id);
    for (const id of before.keys()) if (!names.has(id)) changed.add(id);
    db.transaction(() => {
      db.run('DELETE FROM index_names WHERE source = ?', [key]);
      for (const [id, name] of names)
        db.run('INSERT INTO index_names (source, id, name) VALUES (?, ?, ?)', [key, id, name]);
      db.run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [marker, stamp]);
    });
    const rows: RowInput[] = [];
    for (const id of changed) {
      for (const row of db.query<Row>('SELECT * FROM conv WHERE harness = ? AND kind = ? AND label = ? AND id = ?', [
        source.harness,
        source.kind,
        source.label,
        id,
      ]))
        rows.push({
          ...row,
          index_title: names.get(id)?.slice(0, CONVERSATION_NAME_MAX) ?? null,
          title: undefined,
          hay: undefined,
        });
    }
    this.#write(rows);
  }

  /** The ferret that runs each conversation, and its name today: a rename shows on the next listing. */
  async #applyFerretNames(): Promise<void> {
    const db = this.#open();
    const names = await this.needs.ferretNames().catch((): FerretConversationNames | undefined => undefined);
    if (names === undefined) return;
    const rows: RowInput[] = [];
    const wanted = new Set<string>();
    for (const [key, ferret] of names) {
      const split = key.indexOf(':');
      const harness = key.slice(0, split);
      const id = key.slice(split + 1);
      for (const row of db.query<Row>('SELECT * FROM conv WHERE harness = ? AND id = ?', [harness, id])) {
        wanted.add(`${row.harness}\u0000${row.kind}\u0000${row.label}\u0000${row.path}`);
        const name = ferret.name.slice(0, CONVERSATION_NAME_MAX);
        if (row.ferret_id !== ferret.ferret || row.ferret_name !== name)
          rows.push({ ...row, ferret_id: ferret.ferret, ferret_name: name, title: undefined, hay: undefined });
      }
    }
    for (const row of db.query<Row>('SELECT * FROM conv WHERE ferret_id IS NOT NULL'))
      if (!wanted.has(`${row.harness}\u0000${row.kind}\u0000${row.label}\u0000${row.path}`))
        rows.push({ ...row, ferret_id: null, ferret_name: null, title: undefined, hay: undefined });
    this.#write(rows);
  }

  // ─── query ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The conversations a listing shows, newest first: every word in the search must appear, as a substring, in the ferret's
   * name, the conversation's title, its first or latest message, or its folder (the matcher the listing always used), and
   * the newest copy of a conversation among the allowed kinds is the one listed.
   */
  query(query: IndexQuery = {}): IndexAnswer {
    const db = this.#open();
    const kinds = query.kinds ?? [];
    const kindClause = (alias: string): string =>
      kinds.length === 0 ? '' : ` AND ${alias}.kind IN (${kinds.map(() => '?').join(', ')})`;
    const where: string[] = ['c.ok = 1'];
    const params: unknown[] = [];
    if (query.harness !== undefined) {
      where.push('c.harness = ?');
      params.push(query.harness);
    }
    if (query.sinceMs !== undefined && !Number.isNaN(query.sinceMs)) {
      where.push('c.last_at >= ?');
      params.push(query.sinceMs);
    }
    for (const word of query.words ?? []) {
      where.push('instr(c.hay, ?) > 0');
      params.push(word);
    }
    if (kinds.length > 0) {
      where.push(`c.kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    const winner = `NOT EXISTS (SELECT 1 FROM conv d WHERE d.harness = c.harness AND d.id = c.id AND d.ok = 1 AND d.rowid <> c.rowid${kindClause('d')}
      AND (d.last_at > c.last_at OR (d.last_at = c.last_at AND d.rowid < c.rowid)))`;
    // Across every kind the newest copy is a settled flag; among some kinds only, it is compared in the query.
    const filter = `FROM conv c WHERE ${where.join(' AND ')} AND ${kinds.length === 0 ? 'c.win = 1' : winner}`;
    const filterParams = [...params, ...kinds];
    const matched = db.query<{ n: number }>(`SELECT count(*) AS n ${filter}`, filterParams)[0]?.n ?? 0;
    const limit = query.limit === undefined ? -1 : query.limit;
    const rows = db.query<Row & { also: number }>(
      `SELECT c.*, EXISTS (SELECT 1 FROM conv e WHERE e.harness = c.harness AND e.id = c.id AND e.kind = 'computer' AND e.ok = 1
         AND e.rowid <> c.rowid) AS also ${filter} ORDER BY c.last_at DESC, c.rowid LIMIT ?`,
      [...filterParams, limit],
    );
    const skipped =
      db.query<{ n: number }>(
        `SELECT count(*) AS n FROM conv c WHERE c.ok = 0${query.harness === undefined ? '' : ' AND c.harness = ?'}${kinds.length === 0 ? '' : ` AND c.kind IN (${kinds.map(() => '?').join(', ')})`}`,
        [...(query.harness === undefined ? [] : [query.harness]), ...kinds],
      )[0]?.n ?? 0;
    return { conversations: rows.map(row => this.#wire(row)), matched, skipped };
  }

  /** One conversation, as listed (the newest copy), or `undefined`. */
  get(harness: string | undefined, id: string, kinds?: readonly HarnessHistoryKind[]): IndexedConversation | undefined {
    const db = this.#open();
    const kindSql =
      kinds === undefined || kinds.length === 0 ? '' : ` AND c.kind IN (${kinds.map(() => '?').join(', ')})`;
    const row = db.query<Row & { also: number }>(
      `SELECT c.*, EXISTS (SELECT 1 FROM conv e WHERE e.harness = c.harness AND e.id = c.id AND e.kind = 'computer' AND e.ok = 1
         AND e.rowid <> c.rowid) AS also FROM conv c WHERE c.id = ? AND c.ok = 1${harness === undefined ? '' : ' AND c.harness = ?'}${kindSql}
         ORDER BY c.last_at DESC, c.rowid LIMIT 1`,
      [id, ...(harness === undefined ? [] : [harness]), ...(kinds ?? [])],
    )[0];
    return row === undefined ? undefined : this.#wire(row);
  }

  /** The tree a listed conversation's file is in, for the one fresh read of a preview. */
  sourceOf(conversation: Pick<IndexedConversation, 'harness' | 'kind' | 'label'>): IndexSource | undefined {
    return this.#sources.get(sourceKeyOf(conversation));
  }

  #wire(row: Row & { also: number }): IndexedConversation {
    const title = row.title ?? undefined;
    const ferretName = row.ferret_name ?? undefined;
    const name = truncateText(
      ferretName === undefined
        ? (title ?? truncateText(row.preview, NAME_FALLBACK_MAX))
        : title === undefined || title === ferretName
          ? ferretName
          : `${ferretName} — ${title}`,
      CONVERSATION_NAME_MAX,
    );
    const parser: TranscriptHarness = row.harness === 'codex' ? 'codex' : 'claude';
    return {
      harness: row.harness,
      kind: row.kind,
      label: row.label,
      path: row.path,
      parser,
      row: {
        id: row.id,
        harness: row.harness,
        project: row.project,
        name,
        ...(title === undefined ? {} : { title }),
        ...(row.ferret_id === null ? {} : { ferret: row.ferret_id as FerretId }),
        ...(ferretName === undefined ? {} : { ferretName }),
        preview: row.preview,
        ...(row.latest === null ? {} : { latest: row.latest }),
        lastActivityAt: new Date(row.last_at).toISOString() as Instant,
        turns: row.turns,
        ...(row.turns_at_least === 1 ? { turnsAtLeast: true as const } : {}),
        ...(row.model === null ? {} : { model: row.model }),
        keptIn: row.kind === 'computer' ? 'computer' : 'ferretry',
        ...(row.also === 1 && row.kind !== 'computer' ? { alsoOnComputer: true as const } : {}),
      },
    };
  }

  #indexTitle(source: IndexSource, id: string): string | null {
    return (
      this.#open()
        .query<{ name: string }>('SELECT name FROM index_names WHERE source = ? AND id = ?', [
          sourceKeyOf(source),
          id,
        ])[0]
        ?.name?.slice(0, CONVERSATION_NAME_MAX) ?? null
    );
  }
}

interface Bounded {
  /** Set when the beginning was parsed: whether it held any message of the owner's at all (see the wide look in `#describe`). */
  headOwner?: boolean;
  readonly text: string;
  /** The two ends, each cut to whole records, when the middle was not read. */
  readonly headText: string | undefined;
  readonly tailText: string | undefined;
  readonly partial: boolean;
  readonly scanned: number;
  readonly headSha: string;
}
