/**
 * Asks and the Agenda plugin: every ferret's agenda (and the machine agenda) carried into v5.
 *
 * v5's Asks keeps today's engine and its files, one set per ferret, as OPAQUE bytes it reads itself
 * (`packages/core/asks/manifest.ts`): `state/asks/ferrets/<ferret>/{agenda.json, agenda-replies.json,
 * agenda-history.jsonl, agenda-seen.json}`, the version archives `state/asks/versions/<ferret>~A<n>.sqlite`
 * (`AskVersionsFiles`), and files set aside for a person in `state/asks/set-aside/<ferret>~<name>`. Ask ids stay
 * per ferret, so nothing is renumbered.
 *
 * What differs (v4 4.291.5 → v5, read from both engines):
 * - The ledger: v5 reads `version: 1` ONLY; v4 wrote 4 and upgraded every older file (no version, 1, 2, 3) in memory
 *   as it read it. The converter first reads the board exactly as v4 did (`../v4/agenda/read.ts`, with v4's own
 *   engine vendored), then: `version` 4 → 1; the deprecated item fields `gate`, `gateAttached` and
 *   `gateAttachedChangedAt` are dropped (v5 deleted the standalone gate item and the older-app mirror; a card's gate
 *   rides `cardAsks`); a closed item whose disposition is `replied` (v5 has no such disposition) is closed as `done`.
 *   Every other byte of the item is kept in its order. v5's new optional fields (`raisedObligations`,
 *   `generatedSubject`, `ownAskRepliedTo`) are absent, as on any board v5 never touched.
 * - The history (`agenda-history.jsonl`): the same JSONL records; a `version` record of a `replied` close becomes
 *   `done`, and the ledger's byte cursor is recomputed over the rewritten bytes. Bytes past v4's committed cursor
 *   (never committed; v4 cuts them at its next append) are not carried.
 * - The version archives: the same four tables. v4 is at `user_version` 2 (1 lacks `mutations`; a draft `.jsonl`
 *   archive is imported once); v5's kernel opens `user_version` 1 only. Each archive is COPIED, the copy brought to
 *   v4's shape, then given `user_version` 1, and only snapshots of a `replied` close are rewritten (to `done`).
 * - The held answers (`agenda-replies.json`) and the per-device seen marks (`agenda-seen.json`): identical formats,
 *   carried byte for byte. One v4 would set aside as damaged goes to v5's set-aside folder instead.
 *
 * A v4 that did not stop cleanly leaves a write-ahead intent; the step then fails, naming the file.
 */
import { BuzzRecordSchema, BUZZES, SEEN, SeenFileSchema } from '@ferretry/plugin-agenda/contract';
import { AskItemSchema, AskVersionsFiles } from '@ferretry/core-asks/contract';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealed } from '../sealed.ts';
import { AGENDA_ARCHIVE_FILE } from '../v4/agenda/engine/archive.ts';
import type { AgendaEntry, AgendaLedger } from '../v4/agenda/engine/state-machine.ts';
import { AgendaConversationEntrySchema, AgendaVersionSchema } from '../v4/agenda/protocol/index.ts';
import {
  readAgendaFile,
  readV4Board,
  regularFile,
  V4_AGENDA_FILES,
  V4_AGENDA_LEDGER_VERSION,
  V4_AGENDA_VERSIONS_DIRECTORY,
  VERSION_TABLES,
} from '../v4/agenda/read.ts';
import { directories, info } from '../v4/ferrets.ts';
import type { Step, StepContext } from './index.ts';

/** v5's ledger format (`AGENDA_LEDGER_VERSION`, packages/core/asks/daemon/lib/agenda/state-machine.ts). */
export const V5_AGENDA_LEDGER_VERSION = 1;
/** The machine agenda's pseudo-ferret (`MACHINE_AGENDA_ID`), the same in both. */
export const MACHINE_AGENDA_ID = 'machine-agenda';
/** `isAgendaSessionId` in both engines. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/** A name the kernel accepts in a state collection (`COLLECTION_NAME`, kernel host state-port). */
const COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;
const ASK_ID = /^A[1-9][0-9]*$/u;

/** Asks' declared per-ferret files (manifest.ts is not a contract, so its paths are named here). */
export const v5AgendaFile = (ferret: string, name: string): string => join('state/asks/ferrets', ferret, name);
export const v5VersionArchive = (ferret: string, id: string): string =>
  join('state/asks', AskVersionsFiles.path.replace('*', `${ferret}~${id}`));
export const v5SetAside = (ferret: string, name: string): string => join('state/asks/set-aside', `${ferret}~${name}`);
export const V5_BUZZES_FILE = join('state/agenda', BUZZES.path);
export const V5_SEEN_FILE = join('state/agenda', SEEN.path);

/** A failure whose sentence names a file and never its content. */
class Refused extends Error {}

/** The write-ahead intents v4 leaves only when it stopped mid-commit (adapters/agenda/*). */
const PENDING_INTENTS = ['agenda-versions.pending.json', 'agenda-history.jsonl.pending'] as const;
const PENDING_CHANGES = 'agenda-changes.pending.json';
/** v4's set-aside copies: a stale intent, a damaged outbox, corrupt seen marks. */
const SET_ASIDE =
  /^(agenda-versions\.pending\.json\.stale|agenda-replies\.json\.damaged-|attention-replies\.json\.damaged-|agenda-seen\.json\.corrupt-)/u;
const DEPRECATED_ITEM_FIELDS = ['gate', 'gateAttached', 'gateAttachedChangedAt'] as const;
const SeenMarksSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()));

interface Tally {
  boards: number;
  upgraded: number;
  open: number;
  closed: number;
  repliedClosed: number;
  gateFields: number;
  setAsideByV5: number;
  history: number;
  uncommittedBytes: number;
  archives: number;
  archiveSnapshots: number;
  replies: number;
  heldAnswers: number;
  seen: number;
  setAside: number;
  notNamed: number;
  retired: number;
  cardAskItems: Set<string>;
}

type Json = Record<string, unknown>;

/** One item as v5 reads it: the deprecated gate fields dropped, a `replied` close made `done`. Key order kept. */
function v5Item(item: Json, closed: boolean, tally: Tally): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(item)) {
    if ((DEPRECATED_ITEM_FIELDS as readonly string[]).includes(key)) {
      tally.gateFields++;
      continue;
    }
    out[key] = key === 'disposition' && closed && value === 'replied' ? 'done' : value;
  }
  if (closed && item.disposition === 'replied') tally.repliedClosed++;
  return out;
}

function v5Entry(entry: AgendaEntry, tally: Tally): Json {
  const closed = entry.lifecycle === 'addressed';
  const item = v5Item(entry.item as unknown as Json, closed, tally);
  // v5 reads an item with its own schema and SETS ASIDE one it cannot read (kept verbatim, counted as unreadable).
  if (!AskItemSchema.safeParse(item).success) tally.setAsideByV5++;
  return { ...(entry as unknown as Json), item };
}

/** A history line as v5 reads it: only a `version` record of a `replied` close changes (to `done`). */
function v5HistoryLine(line: string): string {
  const record = JSON.parse(line) as Json;
  const item = record.item as Json | undefined;
  if (record.kind !== 'version' || item?.disposition !== 'replied' || typeof item.resolvedAt !== 'string') return line;
  return JSON.stringify({ ...record, item: { ...item, disposition: 'done' } });
}

/** The history and the ledger's cursor over it, as v5 reads them. */
function v5History(history: Buffer): { bytes: Buffer; count: number } {
  if (history.length === 0) return { bytes: history, count: 0 };
  const text = history.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('incomplete agenda history');
  const lines = text.slice(0, -1).split('\n').map(v5HistoryLine);
  return { bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), count: lines.length };
}

/** v5's `agendaLedgerDocument`: the ledger, its unreadable entries last, 2-space JSON and a newline. */
function v5Ledger(ledger: AgendaLedger, archive: { bytes: number; count: number } | undefined, tally: Tally): string {
  const carried = Object.entries(ledger.carriedEntries ?? {});
  const document = {
    sessionId: ledger.sessionId,
    nextId: ledger.nextId,
    entries: [...ledger.entries.map(entry => v5Entry(entry, tally)), ...(ledger.unreadable ?? [])],
    ...(ledger.conversations === undefined ? {} : { conversations: ledger.conversations }),
    ...(carried.length === 0
      ? {}
      : { carriedEntries: Object.fromEntries(carried.map(([id, entry]) => [id, v5Entry(entry, { ...tally })])) }),
    updatedAt: ledger.updatedAt,
    ...(archive === undefined ? {} : { archive }),
    version: V5_AGENDA_LEDGER_VERSION,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function present(path: string): Promise<boolean> {
  return (await info(path)) !== undefined;
}

/** A v4 file name relative to the home, for a sentence (never its content). */
const named = (ctx: StepContext, path: string): string => path.slice(ctx.v4.home.length + 1);

/** Opens a version archive copy, bringing it to v4's current SQLite shape exactly as v4's `open` did. */
function openArchive(file: string, legacy: string | undefined): Database {
  const db = new Database(file, { create: true, strict: true });
  try {
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    const tables = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n;
    if (version === 2) return db;
    if (version === 1) {
      db.transaction(() => {
        db.run('CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY) WITHOUT ROWID');
        db.run('PRAGMA user_version = 2');
      })();
      return db;
    }
    if (version !== 0 || tables !== 0) throw new Error('unknown version archive');
    db.transaction(() => {
      for (const sql of VERSION_TABLES) db.run(sql);
      for (const record of legacyVersions(legacy ?? '')) saveVersion(db, record.snapshot, record.conversation);
      db.run('PRAGMA user_version = 2');
    })();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const StoredVersionSchema = z.strictObject({
  snapshot: AgendaVersionSchema,
  conversation: z.array(AgendaConversationEntrySchema).optional(),
});

/** v4's `versionsIn`: every complete draft record, a torn tail skipped. */
function legacyVersions(text: string): z.infer<typeof StoredVersionSchema>[] {
  const versions: z.infer<typeof StoredVersionSchema>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      const parsed = StoredVersionSchema.safeParse(value);
      if (parsed.success) versions.push(parsed.data);
      else {
        const bare = AgendaVersionSchema.safeParse(value);
        if (bare.success) versions.push({ snapshot: bare.data });
      }
    } catch {
      // A torn draft tail does not discard the complete versions before it (v4's rule).
    }
  }
  return versions;
}

/** v4's `save`: the snapshot, its summary and its words by SHA-256. */
function saveVersion(
  db: Database,
  snapshot: z.infer<typeof AgendaVersionSchema>,
  conversation?: readonly z.infer<typeof AgendaConversationEntrySchema>[],
): void {
  const summary = {
    version: snapshot.version,
    at: snapshot.at,
    by: snapshot.by,
    change: snapshot.change,
    lifecycle: snapshot.lifecycle,
  };
  const inserted = db.run('INSERT OR IGNORE INTO versions VALUES (?, ?, ?)', [
    snapshot.version,
    JSON.stringify(snapshot),
    JSON.stringify(summary),
  ]);
  if (inserted.changes === 0) return;
  for (const [position, entry] of (conversation ?? snapshot.item.conversation ?? []).entries()) {
    const text = JSON.stringify(AgendaConversationEntrySchema.parse(entry));
    const hash = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    db.run('INSERT OR IGNORE INTO words VALUES (?, ?)', [hash, text]);
    db.run('INSERT INTO version_words VALUES (?, ?, ?)', [snapshot.version, position, hash]);
  }
}

/** The finished copy: only a `replied` close's snapshot changes, then v5's format. */
function finishArchive(db: Database): number {
  let rewritten = 0;
  db.transaction(() => {
    for (const row of db
      .query<{ version: number; snapshot: string }, []>('SELECT version, snapshot FROM versions')
      .all()) {
      const snapshot = JSON.parse(row.snapshot) as Json;
      const item = snapshot.item as Json | undefined;
      if (snapshot.lifecycle !== 'addressed' || item?.disposition !== 'replied') continue;
      db.run('UPDATE versions SET snapshot = ? WHERE version = ?', [
        JSON.stringify({ ...snapshot, item: { ...item, disposition: 'done' } }),
        row.version,
      ]);
      rewritten++;
    }
    db.run(`PRAGMA user_version = ${AskVersionsFiles.format}`);
  })();
  return rewritten;
}

interface Folder {
  readonly ferret: string;
  readonly dir: string;
}

async function folders(ctx: StepContext): Promise<Folder[]> {
  const found = (await directories(ctx.v4.sessions))
    .filter(name => SESSION_ID.test(name))
    .map(name => ({ ferret: name, dir: join(ctx.v4.sessions, name) }));
  const machine = join(ctx.v4.state, MACHINE_AGENDA_ID);
  const source = await info(machine);
  if (source !== undefined) {
    if (!source.isDirectory()) throw new Error('machine agenda is not a folder');
    found.push({ ferret: MACHINE_AGENDA_ID, dir: machine });
  }
  return found;
}

/** Fails, naming the file, when v4 stopped in the middle of an agenda commit. */
async function refuseUnfinished(ctx: StepContext, dir: string): Promise<void> {
  for (const name of PENDING_INTENTS)
    if (await present(join(dir, name)))
      throw new Refused(
        `${named(ctx, join(dir, name))} is an unfinished agenda commit: v4 did not stop cleanly; start v4 once so it recovers, stop it, and convert again`,
      );
  const changes = await regularFile(join(dir, PENDING_CHANGES));
  if (changes === undefined) return;
  let empty = false;
  try {
    const value: unknown = JSON.parse(changes.toString('utf8'));
    empty = Array.isArray(value) && value.length === 0;
  } catch {
    empty = false;
  }
  if (!empty)
    throw new Refused(
      `${named(ctx, join(dir, PENDING_CHANGES))} holds agenda changes v4 never delivered: start v4 once so it delivers them, stop it, and convert again`,
    );
}

async function convertFolder(ctx: StepContext, folder: Folder, scratch: string, tally: Tally): Promise<void> {
  const { ferret, dir } = folder;
  await refuseUnfinished(ctx, dir);
  const names = (await readdir(dir, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink());

  // The version archives: copies brought to v4's shape first, so the read below sees what v4 saw.
  const archives = new Map<string, { db: Database }>();
  const versionsDir = join(dir, V4_AGENDA_VERSIONS_DIRECTORY);
  try {
    const source = await info(versionsDir);
    if (source !== undefined) {
      if (!source.isDirectory()) throw new Error('version archives are not a folder');
      const files = await readdir(versionsDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isSymbolicLink()) throw new Error('version archive is a link');
        if (/\.sqlite-(journal|wal)$/u.test(file.name))
          throw new Refused(
            `${named(ctx, join(versionsDir, file.name))} is an unfinished SQLite write: v4 did not stop cleanly; start v4 once, stop it, and convert again`,
          );
      }
      const ids = new Set(
        files.flatMap(file => {
          const match = /^(A[1-9][0-9]*)\.(sqlite|jsonl)$/u.exec(file.name);
          return match?.[1] === undefined ? [] : [match[1]];
        }),
      );
      for (const id of [...ids].sort()) {
        const sqlite = join(versionsDir, `${id}.sqlite`);
        const target = v5VersionArchive(ferret, id);
        const file = ctx.dryRun ? join(scratch, `${ferret}~${id}.sqlite`) : ctx.v5.resolve(target);
        if (await present(sqlite)) await moveSealed(sqlite, file);
        else {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          await writeFile(file, '', { flag: 'wx', mode: 0o600 });
        }
        const legacy = await regularFile(join(versionsDir, `${id}.jsonl`));
        archives.set(id, { db: openArchive(file, legacy?.toString('utf8')) });
      }
    }

    const board = await readV4Board(dir, ferret, id => archives.get(id)?.db);
    if (board !== undefined) {
      tally.boards++;
      if (board.version !== V4_AGENDA_LEDGER_VERSION) tally.upgraded++;
      tally.uncommittedBytes += board.uncommittedBytes;
      const history = v5History(board.history);
      const cursor =
        board.ledger.archive === undefined && history.count === 0
          ? undefined
          : { bytes: history.bytes.length, count: history.count };
      if (cursor !== undefined && board.ledger.archive !== undefined && cursor.count !== board.ledger.archive.count)
        throw new Error('history does not match its cursor');
      for (const entry of board.ledger.entries) {
        if (entry.lifecycle === 'active') tally.open++;
        else tally.closed++;
        const item = entry.item as unknown as Json;
        if (entry.lifecycle === 'active' && Array.isArray(item.cardAsks))
          tally.cardAskItems.add(`${ferret}:${String(item.id)}`);
      }
      tally.history += history.count;
      await ctx.v5.opaque(v5AgendaFile(ferret, 'agenda.json'), v5Ledger(board.ledger, cursor, tally));
      if (history.bytes.length > 0) await ctx.v5.opaque(v5AgendaFile(ferret, AGENDA_ARCHIVE_FILE), history.bytes);
    }

    for (const archive of archives.values()) {
      tally.archiveSnapshots += finishArchive(archive.db);
      tally.archives++;
    }
  } finally {
    for (const archive of archives.values()) archive.db.close();
  }

  // The held answers: carried as they are; one v4 would set aside as damaged goes to v5's set-aside folder.
  const outbox = await readAgendaFile(dir, 'outbox');
  if (outbox !== undefined) {
    let held: number | undefined;
    try {
      const value = JSON.parse(outbox.bytes.toString('utf8')) as Json;
      if (value.v === 1 && value.sessionId === ferret && Array.isArray(value.pending) && Array.isArray(value.sending))
        held = value.pending.length + value.sending.length;
    } catch {
      held = undefined;
    }
    if (held === undefined) {
      await ctx.v5.opaque(v5SetAside(ferret, `${V4_AGENDA_FILES.outbox.current}.damaged-v4`), outbox.bytes);
      tally.setAside++;
    } else {
      await ctx.v5.opaque(v5AgendaFile(ferret, V4_AGENDA_FILES.outbox.current), outbox.bytes);
      tally.replies++;
      tally.heldAnswers += held;
    }
  }

  // The per-device seen marks: carried as they are, or set aside as v4 would have.
  const seen = await regularFile(join(dir, 'agenda-seen.json'));
  if (seen !== undefined) {
    let readable = false;
    try {
      readable = SeenMarksSchema.safeParse(JSON.parse(seen.toString('utf8'))).success;
    } catch {
      readable = false;
    }
    await ctx.v5.opaque(
      readable ? v5AgendaFile(ferret, 'agenda-seen.json') : v5SetAside(ferret, 'agenda-seen.json.corrupt-v4'),
      seen,
    );
    if (readable) tally.seen++;
    else tally.setAside++;
  }

  for (const entry of names) {
    if (!entry.isFile()) continue;
    const { name } = entry;
    if (SET_ASIDE.test(name)) {
      const target = `${ferret}~${name}`;
      if (!COLLECTION_NAME.test(target)) {
        tally.notNamed++;
        continue;
      }
      await ctx.v5.opaque(v5SetAside(ferret, name), (await regularFile(join(dir, name))) ?? Buffer.alloc(0));
      tally.setAside++;
    } else if (name.endsWith('.migrated') && /^(attention|agenda)/u.test(name)) tally.retired++;
    else if (name === V4_AGENDA_FILES.ledger.legacy || name === V4_AGENDA_FILES.outbox.legacy) {
      // Read above only when the new name is absent; otherwise a retired copy v4 no longer read.
      const current = name === V4_AGENDA_FILES.ledger.legacy ? V4_AGENDA_FILES.ledger : V4_AGENDA_FILES.outbox;
      if (await present(join(dir, current.current))) tally.retired++;
    }
  }
}

// ─── the Agenda plugin: buzzes and seen, from v4's notification ledger ─────────────────────────────────────────

const V4NotificationLine = z.looseObject({
  v: z.literal(1),
  phase: z.literal('requested'),
  at: z.string(),
  origin: z.string(),
  sessionId: z.string().optional(),
});

/**
 * v4's `state/notifications.jsonl` → the Agenda plugin's `buzzes.jsonl` and `seen.json`.
 *
 * - A buzz record stops v5 buzzing the same moment twice. v5 can only meet again the ask's OWN buzz
 *   (`ask:<ferret>:<ask>`, a notice asked for the phone or a card's ask); every other key names an instant or
 *   another plugin's key, so only v4's `ping` push (→ `notice`) and an item's own push while it carries card asks
 *   (→ `card-ask`) are carried, the first line per ask.
 * - `seen` is when the owner last opened each ask: v4 recorded that as an `agenda-clear` line naming `opened`.
 */
async function convertNotifications(
  ctx: StepContext,
  cardAskItems: ReadonlySet<string>,
): Promise<{ buzzes: number; seen: number; lines: number; skipped: number }> {
  const bytes = await regularFile(join(ctx.v4.state, 'notifications.jsonl'));
  if (bytes === undefined) return { buzzes: 0, seen: 0, lines: 0, skipped: 0 };
  const buzzes = new Map<string, z.infer<typeof BuzzRecordSchema>>();
  const seen: Record<string, Record<string, string>> = {};
  let lines = 0;
  let skipped = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    lines++;
    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch {
      skipped++;
      continue;
    }
    const head = V4NotificationLine.safeParse(value);
    if (!head.success || head.data.sessionId === undefined || !SESSION_ID.test(head.data.sessionId)) continue;
    const ferret = head.data.sessionId;
    if (head.data.origin === 'agenda-clear') {
      const opened = value.opened;
      if (typeof opened !== 'string' || !ASK_ID.test(opened) || !Number.isFinite(Date.parse(head.data.at))) continue;
      const before = seen[ferret]?.[opened];
      if (before === undefined || Date.parse(before) < Date.parse(head.data.at))
        seen[ferret] = { ...seen[ferret], [opened]: head.data.at };
      continue;
    }
    if (head.data.origin !== 'agenda' && head.data.origin !== 'attention') continue;
    const ask = value.agendaId ?? value.attentionId;
    if (typeof ask !== 'string' || !ASK_ID.test(ask)) continue;
    const variant = ['stoppedAt', 'deadline', 'woke', 'phoneApproval', 'infoRequest', 'surfaced'].some(
      key => value[key] !== undefined,
    );
    const kind =
      value.ping === true ? 'notice' : !variant && cardAskItems.has(`${ferret}:${ask}`) ? 'card-ask' : undefined;
    const key = `ask:${ferret}:${ask}`;
    if (kind === undefined || buzzes.has(key)) continue;
    const sent = value.sent as Json | undefined;
    const record = BuzzRecordSchema.safeParse({
      format: 1,
      key,
      at: head.data.at,
      kind,
      ferret,
      ask,
      title: typeof sent?.title === 'string' && sent.title !== '' ? sent.title : ask,
      enrolled: value.enrolled,
    });
    if (record.success) buzzes.set(key, record.data);
  }
  if (buzzes.size > 0)
    await ctx.v5.jsonl(
      { ...BUZZES, path: V5_BUZZES_FILE, schema: BuzzRecordSchema },
      [...buzzes.values()].sort((left, right) => left.at.localeCompare(right.at)),
    );
  const marks = Object.values(seen).reduce((sum, asks) => sum + Object.keys(asks).length, 0);
  if (marks > 0) await ctx.v5.json({ ...SEEN, path: V5_SEEN_FILE, schema: SeenFileSchema }, { format: 1, seen });
  return { buzzes: buzzes.size, seen: marks, lines, skipped };
}

export const agendaStep: Step = {
  id: 'asks',
  title: 'Asks and agenda (boards, history, versions, held answers, seen marks, buzzes)',
  owner: ['core-asks', 'plugin-agenda'],
  reads: [
    'state/sessions/<sid>/{agenda,agenda-replies,agenda-seen}.json (or attention*.json when never renamed)',
    'state/sessions/<sid>/agenda-history.jsonl',
    'state/sessions/<sid>/agenda-versions/A<n>.{sqlite,jsonl}',
    'state/machine-agenda/ (the same files, ferret machine-agenda)',
    'state/notifications.jsonl',
  ],
  sealed: [],
  notCarried: [
    {
      what: 'item fields gate, gateAttached and gateAttachedChangedAt',
      why: 'v5 deleted the standalone gate item and the older-app mirror; a card gate rides the item’s cardAsks, which are kept',
    },
    {
      what: 'the replied disposition',
      why: 'v5 has none (a reply rests an item). v4’s own read reopened a replied close as resting where the board had room, and that is kept; a replied close it left closed is closed as done in the ledger, the history and the version snapshots',
    },
    {
      what: 'history bytes past the committed cursor',
      why: 'never committed; v4 cuts them at its next append',
    },
    {
      what: 'attention.json, attention-replies.json beside their new names, and *.migrated',
      why: 'retired pre-rename copies v4 no longer read',
    },
    {
      what: 'empty agenda-changes.pending.json',
      why: 'its resting state: nothing left to deliver',
    },
    {
      what: 'agenda-versions/A<n>.jsonl beside an initialised archive',
      why: 'a draft archive v4 already imported into the SQLite file',
    },
    {
      what: 'state/machine-agenda-members.json and the warden member files',
      why: 'de-duplication memory v5 rebuilds',
    },
    {
      what: 'notifications.jsonl direct pushes, outcomes, and stop, deadline, wake, phone-approval and info pushes',
      why: 'v5 keys those buzzes by an instant or another plugin’s key, so a carried line could never match one; only an ask’s own buzz (a ping notice, a card ask) and the owner’s opens (seen) are carried',
    },
    {
      what: 'v4 set-aside agenda files whose name v5 cannot hold',
      why: 'the kernel’s collection names are at most 201 characters of [A-Za-z0-9._%~-]',
    },
  ],
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    const tally: Tally = {
      boards: 0,
      upgraded: 0,
      open: 0,
      closed: 0,
      repliedClosed: 0,
      gateFields: 0,
      setAsideByV5: 0,
      history: 0,
      uncommittedBytes: 0,
      archives: 0,
      archiveSnapshots: 0,
      replies: 0,
      heldAnswers: 0,
      seen: 0,
      setAside: 0,
      notNamed: 0,
      retired: 0,
      cardAskItems: new Set(),
    };
    const scratch = await mkdtemp(join(tmpdir(), 'fy-agenda-'));
    try {
      for (const folder of await folders(ctx)) await convertFolder(ctx, folder, scratch, tally);
      const notifications = await convertNotifications(ctx, tally.cardAskItems);
      const kept: KeptItem[] = [
        { what: 'agenda boards (ferrets and the machine agenda)', count: tally.boards },
        { what: 'boards upgraded from an older v4 shape with v4’s own reader', count: tally.upgraded },
        { what: 'open asks', count: tally.open },
        { what: 'closed asks', count: tally.closed },
        { what: 'replied closes carried as done', count: tally.repliedClosed },
        { what: 'deprecated gate fields dropped', count: tally.gateFields },
        { what: 'entries v5 sets aside as unreadable (kept byte for byte)', count: tally.setAsideByV5 },
        { what: 'history records', count: tally.history },
        { what: 'uncommitted history bytes not carried', count: tally.uncommittedBytes },
        { what: 'version archives', count: tally.archives },
        { what: 'version snapshots of a replied close rewritten as done', count: tally.archiveSnapshots },
        { what: 'held-answer files', count: tally.replies },
        { what: 'held answers and batches', count: tally.heldAnswers },
        { what: 'per-device seen-mark files', count: tally.seen },
        { what: 'files set aside for a person', count: tally.setAside },
        { what: 'set-aside files not carried (name too long for v5)', count: tally.notNamed },
        { what: 'retired pre-rename agenda files not carried', count: tally.retired },
        { what: 'buzz records', count: notifications.buzzes },
        { what: 'owner seen marks', count: notifications.seen },
        { what: 'unreadable notification lines skipped (as v4 did)', count: notifications.skipped },
      ];
      return { ...base, status: 'converted', ...(ctx.dryRun ? { note: 'dry run: nothing written' } : {}), kept };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note:
          error instanceof Refused ? error.message : 'cannot convert agenda input: invalid data or an unavailable file',
        kept: [],
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
};
