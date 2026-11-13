/**
 * THE ARCHIVE REGISTRY: which sessions have left the live set, and what the index knew of each.
 *
 * One small document, `state/archived-sessions.json`, written atomically. An archived session's directory
 * stays exactly where it was — nothing is moved, nothing is deleted — so the registry is the ONLY fact that
 * says "archived", and a daemon that loses it simply sees every session as live again at the next boot's
 * reconcile. That is why archiving in place was chosen over moving directories: documents, journal,
 * transcript pointers and every subsystem that writes into `state/sessions/<id>/` (the agenda, the channel,
 * the board's stamps) keep working with no second path to teach them, and a crash can never strand half a
 * move.
 *
 * Each entry keeps the session's `IndexedSession` row as it was at archive time. The journal of an archived
 * session does not change (a write revives it first), so that row stays true, and it is what lets
 * `findSession` answer for an archived id from memory without a disk read.
 */
import { InstantSchema } from '../../protocol/common.ts';
import { z } from 'zod';
import type { IndexedSession } from '../../storage-types.ts';
import { tryParseSessionId, type SessionId } from '../../session-id.ts';

const JournalFingerprintSchema = z.strictObject({
  device: z.string(),
  inode: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
});

const ArchivedSessionSchema = z.strictObject({
  archivedAt: InstantSchema,
  /** The agent name the session answered to (`config.teammate`), so a name still addresses it. */
  name: z.string().optional(),
  /** The configuration's own `createdAt` and `updatedAt`, which a callsign's hold on its name is measured from. */
  configCreatedAt: z.string().optional(),
  configUpdatedAt: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastSequence: z.number().int().nonnegative(),
  journalLine: z.number().int().positive(),
  journal: JournalFingerprintSchema.nullable(),
});

const ArchiveRegistryDocumentSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.record(z.string(), ArchivedSessionSchema),
});

/** One archived session: when it left, and the index row it had. */
export interface ArchivedSession {
  readonly archivedAt: string;
  /** The agent name it answered to, so `fy send <name>` and `fy history <name>` still find it. */
  readonly name?: string;
  /** What the callsign's hold on `name` is measured from: the configuration's `createdAt` and `updatedAt`. */
  readonly configTimes?: { readonly createdAt: string; readonly updatedAt: string };
  readonly indexed: IndexedSession;
}

/** Parses the stored document; `undefined` for one that is absent, damaged or from a newer shape. */
export function parseArchiveRegistry(text: string | undefined): ReadonlyMap<SessionId, ArchivedSession> | undefined {
  if (text === undefined) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ArchiveRegistryDocumentSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const sessions = new Map<SessionId, ArchivedSession>();
  for (const [name, entry] of Object.entries(parsed.data.sessions)) {
    const id = tryParseSessionId(name);
    if (id === undefined) continue;
    sessions.set(id, {
      archivedAt: entry.archivedAt,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.configCreatedAt === undefined || entry.configUpdatedAt === undefined
        ? {}
        : { configTimes: { createdAt: entry.configCreatedAt, updatedAt: entry.configUpdatedAt } }),
      indexed: {
        id,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
        ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        lastSequence: entry.lastSequence,
        journalLine: entry.journalLine,
        journal: entry.journal,
      },
    });
  }
  return sessions;
}

/** The document for a registry: keys sorted, so two writes of the same set are the same bytes. */
export function serializeArchiveRegistry(sessions: ReadonlyMap<SessionId, ArchivedSession>): string {
  const document: Record<string, z.infer<typeof ArchivedSessionSchema>> = {};
  for (const [id, entry] of [...sessions].sort(([left], [right]) => left.localeCompare(right))) {
    const { indexed } = entry;
    document[id] = {
      archivedAt: entry.archivedAt,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.configTimes === undefined
        ? {}
        : { configCreatedAt: entry.configTimes.createdAt, configUpdatedAt: entry.configTimes.updatedAt }),
      ...(indexed.status === undefined ? {} : { status: indexed.status }),
      ...(indexed.createdAt === undefined ? {} : { createdAt: indexed.createdAt }),
      ...(indexed.updatedAt === undefined ? {} : { updatedAt: indexed.updatedAt }),
      lastSequence: indexed.lastSequence,
      journalLine: indexed.journalLine,
      journal: indexed.journal,
    };
  }
  return `${JSON.stringify({ version: 1, sessions: document }, null, 2)}\n`;
}
