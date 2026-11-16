import { defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { IsoInstantSchema } from '../records.ts';

// ─── archive.json (today's archive registry, `lib/session/archive/registry.ts`) ────────────────────────────────

/** What stands in for a journal file's identity, as the index and the archive record it. */
export const JournalFingerprintSchema = z.strictObject({
  device: z.string(),
  inode: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
});

/** One archived ferret: when it left the live set, and the index row it had. */
export const ArchivedFerretSchema = z.strictObject({
  archivedAt: IsoInstantSchema,
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

/**
 * `archive.json`: one entry per archived ferret, by id. The state port stamps and checks `format: 1`, so the body
 * carries no `version` of its own (today's carried `version: 1`).
 */
export const ArchiveDocumentSchema = z.strictObject({
  sessions: z.record(z.string(), ArchivedFerretSchema),
});
export type ArchiveDocument = z.infer<typeof ArchiveDocumentSchema>;
export const ArchiveFile = defineState({
  name: 'archive',
  path: 'archive.json',
  store: 'json',
  format: 1,
  schema: ArchiveDocumentSchema,
});

// ─── archive.yaml (the session archive's one setting) ─────────────────────────────────────────────────────────────

/**
 * `archive.yaml` (docs/session-archive.md): how long a finished autonomous ferret stays live before the archive pass
 * takes it out of the live set. ABSENT, `off` or no key is OFF: nothing more is archived (what is already archived stays
 * readable and revivable). Today this was the `FYD_SESSION_ARCHIVE_AFTER_HOURS` variable; no plugin reads the environment.
 * Archiving only hides a session from the live list, and only a write brings it back, so no edit of this file widens
 * authority or spend.
 */
/** The longest age `archive.yaml` holds: a year of hours (the one owner of the bound; the v4 converter reads it too). */
export const ARCHIVE_MAX_HOURS = 24 * 365;
export const ArchiveSettingsSchema = z.strictObject({
  afterHours: z.union([z.literal('off'), z.number().int().min(1).max(ARCHIVE_MAX_HOURS)]).optional(),
});
export type ArchiveSettings = z.infer<typeof ArchiveSettingsSchema>;
export const ArchiveConfigFile = defineConfig({
  file: 'archive.yaml',
  schema: ArchiveSettingsSchema,
  axis: 'configure',
  loosens: neverLoosens,
});
