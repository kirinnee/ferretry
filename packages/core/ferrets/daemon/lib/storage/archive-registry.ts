/**
 * THE ARCHIVE REGISTRY'S DOCUMENT, as the contract's `ArchiveFile` (`archive.json`) holds it.
 *
 * Today's `parseArchiveRegistry` / `serializeArchiveRegistry` (`lib/session/archive/registry.ts`), at the level of
 * the value the state port reads and writes rather than text. The state port stamps and checks `format: 1`, so the
 * body no longer carries today's `version: 1`; everything else — one entry per archived session with the index row
 * it had — is unchanged. The `ArchivedSession` type stays where today's registry module declares it.
 */
import type { z } from 'zod';
import { ArchiveDocumentSchema, type ArchivedFerretSchema } from '../../../contract/state.ts';
import type { ArchivedSession } from '../session/archive/registry.ts';
import { type SessionId, tryParseSessionId } from '../session-id.ts';

/** The registry body; the contract owns it as `ArchiveFile`'s schema. */
export const ArchiveRegistryValueSchema = ArchiveDocumentSchema;
export type ArchiveRegistryValue = z.infer<typeof ArchiveRegistryValueSchema>;

/** Parses the stored value; `undefined` for one that is damaged. An absent document is an empty registry. */
export function parseArchiveRegistryValue(value: unknown): ReadonlyMap<SessionId, ArchivedSession> | undefined {
  if (value === undefined) return new Map();
  const parsed = ArchiveRegistryValueSchema.safeParse(value);
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

/** The value for a registry: keys sorted, so two writes of the same set are the same document. */
export function archiveRegistryValue(sessions: ReadonlyMap<SessionId, ArchivedSession>): ArchiveRegistryValue {
  const document: Record<string, z.infer<typeof ArchivedFerretSchema>> = {};
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
  return { sessions: document };
}
