import { z } from 'zod';
import { defineState } from '../../contract/define.ts';

const WriteSetJournalSchema = z.strictObject({
  plugin: z.string().min(1),
  documents: z.array(
    z.strictObject({
      /** The file, relative to `config/`. */
      path: z.string().min(1),
      /** Its text before the set, `null` when there was no file. */
      prior: z.string().nullable(),
      /** Its accepted record before the set, exactly as stored, `null` when there was none. */
      accepted: z
        .strictObject({ etag: z.string().min(1), text: z.string(), plugin: z.string().min(1).optional() })
        .nullable(),
    }),
  ),
});

/** What {@link configWriteSetFile} holds. */
export type WriteSetJournal = z.infer<typeof WriteSetJournalSchema>;

/**
 * The intent record of one `ConfigPort.writeAll` in progress (`state/kernel/config-write-set.json`): for every file of
 * the set, its text and its accepted record AS THEY WERE before the set touched anything. Written (atomically, synced)
 * before the first file is written and removed once every file and every accepted record is — that removal is the
 * set's commit. A record still there on a load means the daemon stopped mid-set, so the load puts every file and every
 * accepted record of it back first, before anything is evaluated.
 *
 * It holds config texts, which never hold a raw secret: a set whose file on disk holds one is refused before this is
 * written, so this record never copies one. Only the config service reads or writes it.
 */
export const configWriteSetFile = defineState({
  name: 'config-write-set',
  path: 'config-write-set.json',
  store: 'json',
  format: 1,
  schema: WriteSetJournalSchema,
  onDamaged: { narrower: 'an interrupted config write set cannot be put back; its files are judged as they are' },
});
