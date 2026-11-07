/**
 * Reading one v4 (4.291.5) agenda folder the way v4 itself read it, so the converter starts from exactly the board
 * v4's NEXT write would have put on disk.
 *
 * v4 never rewrote a ledger on boot: an older file (no `version`, or 1–3) was brought to version 4 only in memory, as
 * it was read, and written back by the next transition. v5 deleted that whole read-time chain (it reads `version: 1`
 * and nothing else), so the converter runs it here, with v4's own code vendored under `./engine` and `./protocol`:
 *
 * - `FileAgendaLedgerRepository.parse` (packages/daemon/src/adapters/agenda/file-agenda-ledger-repository.ts):
 *   the legacy history cursor adoption, the committed archive prefix and the recorded versions it reads;
 * - `parseAgendaLedger` (vendored verbatim): the conversation seed, parked replies, the gate-item lift and the fit;
 * - `plan` + `commit` of the same repository: the read's `archivePending` appended to the history at the cursor.
 *
 * The versions are read from the converter's own COPIES of the version archives (never the v4 files), already
 * brought to v4's current SQLite shape by the step.
 */
import { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { info } from '../ferrets.ts';
import {
  AGENDA_ARCHIVE_FILE,
  type AgendaArchiveCursor,
  AgendaArchiveCursorSchema,
  type AgendaArchiveRecord,
  AgendaArchiveRecordSchema,
} from './engine/archive.ts';
import type { RecordedItem } from './engine/item-words.ts';
import { type AgendaLedger, parseAgendaLedger } from './engine/state-machine.ts';
import {
  type AgendaConversationEntry,
  AgendaConversationEntrySchema,
  AgendaIdSchema,
  type AgendaVersion,
  AgendaVersionSchema,
  AgendaVersionSummarySchema,
} from './protocol/index.ts';

/** `AGENDA_LEDGER_VERSION` at 4.291.5 (`lib/agenda/state-machine.ts:196`). */
export const V4_AGENDA_LEDGER_VERSION = 4;

/** The ledger and outbox, by today's name and the name before the agenda rename (`lib/agenda/agenda-files.ts`). */
export const V4_AGENDA_FILES = {
  ledger: { current: 'agenda.json', legacy: 'attention.json' },
  outbox: { current: 'agenda-replies.json', legacy: 'attention-replies.json' },
} as const;

/** The version archives' folder beside a board (`adapters/agenda/sqlite-agenda-versions.ts:25`). */
export const V4_AGENDA_VERSIONS_DIRECTORY = 'agenda-versions';

/** A v4 file, read only when it is a regular file; `undefined` when absent. Never follows a link. */
export async function regularFile(path: string): Promise<Buffer | undefined> {
  const found = await info(path);
  if (found === undefined) return undefined;
  if (!found.isFile()) throw new Error('v4 agenda input is not a regular file');
  return await readFile(path);
}

/** v4's reader's rule (`readAgendaFile`): the new name when it exists, else the old one. Never both. */
export async function readAgendaFile(
  dir: string,
  kind: keyof typeof V4_AGENDA_FILES,
): Promise<{ readonly name: string; readonly bytes: Buffer } | undefined> {
  for (const name of [V4_AGENDA_FILES[kind].current, V4_AGENDA_FILES[kind].legacy]) {
    const bytes = await regularFile(join(dir, name));
    if (bytes !== undefined) return { name, bytes };
  }
  return undefined;
}

/** `completeLinesCursor` (lib/append-only-log.ts): the extent of every complete line. */
export function completeLinesCursor(bytes: Uint8Array): AgendaArchiveCursor {
  const end = bytes.lastIndexOf(0x0a) + 1;
  return { bytes: end, count: bytes.subarray(0, end).filter(byte => byte === 0x0a).length };
}

/** `encodedRecords` (lib/append-only-log.ts): what an append writes. */
export const encodedRecords = (records: readonly unknown[]): Buffer =>
  Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');

/** `archiveRecords` (file-agenda-ledger-repository.ts:119). */
function archiveRecords(text: string): AgendaArchiveRecord[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('incomplete agenda history');
  return text
    .slice(0, -1)
    .split('\n')
    .map(line => AgendaArchiveRecordSchema.parse(JSON.parse(line)));
}

/** Opens one item's version archive (the converter's copy), or `undefined` when the item has none. */
export type VersionArchives = (id: string) => Database | undefined;

/** `recordedItems` (file-agenda-ledger-repository.ts:265): the latest kept version of each item the document names. */
function recordedItems(
  raw: Record<string, unknown>,
  archives: VersionArchives,
): Record<string, RecordedItem> | undefined {
  if (!Array.isArray(raw.entries)) return undefined;
  const recorded: Record<string, RecordedItem> = {};
  for (const entry of raw.entries as unknown[]) {
    const id = AgendaIdSchema.safeParse((entry as { item?: { id?: unknown } } | null)?.item?.id);
    if (!id.success) continue;
    const db = archives(id.data);
    if (db === undefined) continue;
    const latest = db
      .query<{ summary: string }, []>('SELECT summary FROM versions ORDER BY version')
      .all()
      .map(row => AgendaVersionSummarySchema.parse(JSON.parse(row.summary)))
      .at(-1);
    if (latest === undefined) continue;
    const row = db
      .query<{ snapshot: string }, [number]>('SELECT snapshot FROM versions WHERE version = ?')
      .get(latest.version);
    if (row === null) continue;
    const version: AgendaVersion = AgendaVersionSchema.parse(JSON.parse(row.snapshot));
    const conversation: AgendaConversationEntry[] = db
      .query<{ entry: string }, [number]>(
        'SELECT words.entry FROM version_words JOIN words ON words.hash = version_words.hash WHERE version_words.version = ? ORDER BY version_words.position',
      )
      .all(latest.version)
      .map(word => AgendaConversationEntrySchema.parse(JSON.parse(word.entry)));
    recorded[id.data] = { at: version.at, item: version.item, conversation };
  }
  return Object.keys(recorded).length === 0 ? undefined : recorded;
}

export interface V4Board {
  /** Which file the board was read from (`agenda.json`, or `attention.json` when v4 never renamed it). */
  readonly name: string;
  /** The `version` the file was written at (`undefined` for a file from before versions). */
  readonly version: unknown;
  /** The board as v4's next write commits it: no `archivePending`, its cursor covering `history`. */
  readonly ledger: AgendaLedger;
  /** The committed history: the bytes up to the cursor, then the read's pending records appended. */
  readonly history: Buffer;
  /** History bytes past the committed cursor, which v4 cuts at its next append: never committed. */
  readonly uncommittedBytes: number;
}

/**
 * One ferret's board, as v4 would next write it. Throws (with no file content) when v4 itself would refuse it:
 * a ledger of another ferret, an unreadable document, or a history shorter than its cursor.
 */
export async function readV4Board(
  dir: string,
  sessionId: string,
  archives: VersionArchives,
): Promise<V4Board | undefined> {
  const found = await readAgendaFile(dir, 'ledger');
  if (found === undefined) return undefined;
  const raw = JSON.parse(found.bytes.toString('utf8')) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid ledger');
  const cursor = AgendaArchiveCursorSchema.optional().parse(raw.archive);
  const version = raw.version;
  const history = (await regularFile(join(dir, AGENDA_ARCHIVE_FILE))) ?? Buffer.alloc(0);
  // An older daemon's write dropped the cursor but kept the sidecar: its complete lines are adopted as committed. The
  // step refuses a home with an append mark (`agenda-history.jsonl.pending`), so no never-committed append is here.
  let adopted: AgendaArchiveCursor | undefined;
  if ((version === undefined || version === 1) && cursor === undefined) {
    const lines = completeLinesCursor(history);
    if (lines.count > 0) adopted = lines;
  }
  const committed = cursor ?? adopted;
  const recorded = version === V4_AGENDA_LEDGER_VERSION ? undefined : recordedItems(raw, archives);
  let archived: AgendaArchiveRecord[] = [];
  if (version !== V4_AGENDA_LEDGER_VERSION && committed !== undefined && committed.bytes > 0) {
    if (history.length < committed.bytes) throw new Error('incomplete agenda history');
    archived = archiveRecords(history.subarray(0, committed.bytes).toString('utf8'));
  }
  const parsed = parseAgendaLedger(raw, sessionId, archived, recorded);
  if (parsed === null) throw new Error('invalid ledger');
  const read = adopted === undefined ? parsed : { ...parsed, archive: adopted };
  // `plan` + `commit`: the pending records go after the committed prefix, and the cursor moves past them.
  const { archivePending, ...clean } = read;
  const base = read.archive ?? { bytes: 0, count: 0 };
  if (history.length < base.bytes) throw new Error('append cursor exceeds file');
  const records = archivePending ?? [];
  const kept = history.subarray(0, base.bytes);
  const appended = records.length === 0 ? Buffer.alloc(0) : encodedRecords(records);
  const archive =
    records.length === 0 ? clean.archive : { bytes: base.bytes + appended.length, count: base.count + records.length };
  return {
    name: found.name,
    version,
    ledger: { ...clean, ...(archive === undefined ? {} : { archive }) },
    history: Buffer.concat([kept, appended]),
    uncommittedBytes: history.length - base.bytes,
  };
}

/** The tables v4's archive holds at `user_version` 2 (and v5's at format 1): created only in a file with none. */
export const VERSION_TABLES = [
  'CREATE TABLE mutations (id TEXT PRIMARY KEY) WITHOUT ROWID',
  'CREATE TABLE versions (version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, summary TEXT NOT NULL)',
  'CREATE TABLE words (hash TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID',
  'CREATE TABLE version_words (version INTEGER NOT NULL, position INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (version, position)) WITHOUT ROWID',
] as const;
