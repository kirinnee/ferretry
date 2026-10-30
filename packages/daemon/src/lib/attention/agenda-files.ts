import { AttentionOutboxSchema } from './reply-batch.ts';
import { parseAttentionLedger } from './state-machine.ts';

/** The two documents a ferret's session directory holds for its agenda. */
export type AgendaFileKind = 'ledger' | 'outbox';

/** What each is called now, and what releases before the agenda rename called it. */
export const AGENDA_FILES: Readonly<Record<AgendaFileKind, { readonly current: string; readonly legacy: string }>> = {
  ledger: { current: 'agenda.json', legacy: 'attention.json' },
  outbox: { current: 'agenda-replies.json', legacy: 'attention-replies.json' },
};

/** The name a legacy file keeps once its content lives under the new name; one release keeps it. */
export const MIGRATED_SUFFIX = '.migrated';

/** The one place a session's agenda files are touched, so a test can stand in for the disk. */
export interface AgendaFileStore {
  /** The file's text, or `undefined` when there is no such file. Any other failure rejects. */
  read(sessionId: string, name: string): Promise<string | undefined>;
  /** Replaces the file whole: a temporary file renamed over it. */
  writeAtomic(sessionId: string, name: string, text: string): Promise<void>;
  rename(sessionId: string, from: string, to: string): Promise<void>;
  /** Removes the file; a file already gone is not a failure. */
  remove(sessionId: string, name: string): Promise<void>;
}

/** THE READER'S RULE: the new name when it exists, else the old one. Never both, never a merge. */
export async function readAgendaFile(
  store: Pick<AgendaFileStore, 'read'>,
  sessionId: string,
  kind: AgendaFileKind,
): Promise<{ readonly name: string; readonly text: string } | undefined> {
  const { current, legacy } = AGENDA_FILES[kind];
  const now = await store.read(sessionId, current);
  if (now !== undefined) return { name: current, text: now };
  const before = await store.read(sessionId, legacy);
  return before === undefined ? undefined : { name: legacy, text: before };
}

/** What the migration needs to know about a document it can read. */
interface Understood {
  /** The text the daemon writes for this document, so a copy reads back byte for byte. */
  readonly canonical: string;
  /** How recent it is: compared left to right, the larger side is the newer document. */
  readonly stamp: readonly [number, number];
}

function understand(kind: AgendaFileKind, sessionId: string, text: string): Understood | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (kind === 'ledger') {
    const ledger = parseAttentionLedger(value, sessionId);
    // The ledger has no `v`: it is written bare. Its own `updatedAt` moves on every change it takes, and
    // `nextId` moves on every item it raises, which breaks a tie between two writes in the same instant.
    return ledger === null
      ? undefined
      : { canonical: `${JSON.stringify(ledger, null, 2)}\n`, stamp: [Date.parse(ledger.updatedAt), ledger.nextId] };
  }
  const parsed = AttentionOutboxSchema.safeParse(value);
  if (!parsed.success || parsed.data.sessionId !== sessionId) return undefined;
  const outbox = parsed.data;
  // The outbox carries no clock of its own, so it is dated by the latest instant any answer in it was
  // held or sent. An outbox with nothing in it has no date, and an old one never outranks a new one.
  const instants = [
    ...outbox.pending.map(each => each.at),
    ...outbox.sending.flatMap(batch => [
      ...(batch.sentAt === undefined ? [] : [batch.sentAt]),
      ...(batch.replies ?? []).map(each => each.at),
    ]),
  ].map(Date.parse);
  return { canonical: `${JSON.stringify(outbox, null, 2)}\n`, stamp: [Math.max(0, ...instants), 0] };
}

function newer(a: Understood, b: Understood): boolean {
  return a.stamp[0] === b.stamp[0] ? a.stamp[1] > b.stamp[1] : a.stamp[0] > b.stamp[0];
}

/** Writes `doc` whole as `name` and reads it back; a copy that does not read back equal is removed. */
async function copyVerified(
  store: AgendaFileStore,
  sessionId: string,
  kind: AgendaFileKind,
  name: string,
  doc: Understood,
): Promise<boolean> {
  await store.writeAtomic(sessionId, name, doc.canonical);
  const back = await store.read(sessionId, name);
  if (back !== undefined && understand(kind, sessionId, back)?.canonical === doc.canonical) return true;
  await store.remove(sessionId, name);
  return false;
}

/** The fate of one file kind in one session. */
export type AgendaFileResult = 'nothing' | 'migrated' | 'kept-new' | 'failed';

/**
 * Moves ONE session's ONE file to its new name without losing an item. The new file is written whole and
 * read back equal BEFORE the old one is renamed to `*.migrated`, so a crash at any step leaves a file the
 * reader still understands and the next start finishes. Total: it never rejects.
 *
 * - Only the old file: copied, verified, old renamed.
 * - Both (a crash between the copy and the rename, or a downgrade then an upgrade): the newer document stays
 *   or becomes the new file, and the other is kept as `*.migrated`. A tie keeps the new file.
 * - A file that cannot be read as the document it should be is left exactly where it is, and the session
 *   fails: the reader still reads or sets it aside as it did before, and the next start tries again.
 */
export async function migrateAgendaFile(
  store: AgendaFileStore,
  sessionId: string,
  kind: AgendaFileKind,
): Promise<AgendaFileResult> {
  const { current, legacy } = AGENDA_FILES[kind];
  try {
    const old = await store.read(sessionId, legacy);
    if (old === undefined) return 'nothing';
    const oldDoc = understand(kind, sessionId, old);
    if (oldDoc === undefined) return 'failed';
    const now = await store.read(sessionId, current);
    if (now === undefined) {
      if (!(await copyVerified(store, sessionId, kind, current, oldDoc))) return 'failed';
      await store.rename(sessionId, legacy, `${legacy}${MIGRATED_SUFFIX}`);
      return 'migrated';
    }
    const nowDoc = understand(kind, sessionId, now);
    if (nowDoc === undefined) return 'failed';
    if (newer(oldDoc, nowDoc)) {
      // The new file is set aside first; a copy that fails leaves the old (newer) file in place, which the
      // reader falls back to and the next start migrates again.
      await store.rename(sessionId, current, `${current}${MIGRATED_SUFFIX}`);
      if (!(await copyVerified(store, sessionId, kind, current, oldDoc))) return 'failed';
      await store.rename(sessionId, legacy, `${legacy}${MIGRATED_SUFFIX}`);
      return 'migrated';
    }
    await store.rename(sessionId, legacy, `${legacy}${MIGRATED_SUFFIX}`);
    return 'kept-new';
  } catch {
    return 'failed';
  }
}

/** Where the migration records that it finished: once, for this daemon's home. */
export interface AgendaFilesMigrationMarker {
  ran(): Promise<boolean>;
  record(at: string, counts: AgendaFilesMigrationCounts): Promise<void>;
}

export interface AgendaFilesMigrationCounts {
  readonly sessions: number;
  readonly migrated: number;
  readonly keptNew: number;
  readonly failed: number;
}

export interface AgendaFilesMigrationPorts {
  readonly marker: AgendaFilesMigrationMarker;
  readonly files: AgendaFileStore;
  readonly now: () => string;
  /** One line with the counts; the migration says nothing else. */
  readonly log: (line: string) => void;
}

export interface AgendaFilesMigrationOutcome extends AgendaFilesMigrationCounts {
  readonly ran: boolean;
}

/**
 * THE ONE-TIME MOVE OF THE AGENDA'S FILES to their agenda names (docs/notifications.md § Migration): each
 * session's ledger and outbox, in turn.
 *
 * ONCE, AND NEVER IN THE WAY: the marker is written only when every session was handled, so a session that
 * failed keeps its old file (still read) and is tried again next start; a start that finds the marker does
 * no work. It never rejects, so it can never stop the daemon from starting.
 */
export async function migrateAgendaFiles(
  sessionIds: readonly string[],
  ports: AgendaFilesMigrationPorts,
): Promise<AgendaFilesMigrationOutcome> {
  const none = { sessions: 0, migrated: 0, keptNew: 0, failed: 0 };
  try {
    if (await ports.marker.ran()) return { ran: false, ...none };
    let migrated = 0;
    let keptNew = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      const results = [
        await migrateAgendaFile(ports.files, sessionId, 'ledger'),
        await migrateAgendaFile(ports.files, sessionId, 'outbox'),
      ];
      if (results.includes('failed')) failed += 1;
      else if (results.includes('migrated')) migrated += 1;
      else if (results.includes('kept-new')) keptNew += 1;
    }
    const counts = { sessions: sessionIds.length, migrated, keptNew, failed };
    ports.log(
      `agenda files: ${counts.sessions} sessions, ${migrated} migrated, ${keptNew} already current, ${failed} failed${failed === 0 ? '' : ' (retried next start)'}`,
    );
    if (failed > 0) return { ran: false, ...counts };
    await ports.marker.record(ports.now(), counts);
    return { ran: true, ...counts };
  } catch {
    return { ran: false, ...none };
  }
}
