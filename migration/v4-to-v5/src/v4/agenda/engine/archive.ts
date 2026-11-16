// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/daemon/src/lib/agenda/archive.ts, verbatim except the @ferretry/protocol import path.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
import {
  AgendaHistoryEntrySchema,
  AgendaIdSchema,
  StoredAgendaItemSchema,
  StoredResolvedAgendaItemSchema,
} from '../protocol/index.ts';
import { z } from 'zod';

/** Private per-session append-only history. Neither records nor pending writes are served on the wire. */
export const AGENDA_ARCHIVE_FILE = 'agenda-history.jsonl';
export const AgendaArchiveCursorSchema = z.strictObject({
  bytes: z.number().int().nonnegative().safe(),
  count: z.number().int().nonnegative().safe(),
});
export type AgendaArchiveCursor = z.infer<typeof AgendaArchiveCursorSchema>;
export const AgendaArchiveRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner-history'), id: AgendaIdSchema, entry: AgendaHistoryEntrySchema }),
  z.strictObject({
    kind: z.literal('version'),
    id: AgendaIdSchema,
    item: z.union([StoredResolvedAgendaItemSchema, StoredAgendaItemSchema]),
  }),
]);
export type AgendaArchiveRecord = z.infer<typeof AgendaArchiveRecordSchema>;
