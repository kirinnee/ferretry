/**
 * The spawn stamp's durable home: the session's own configuration document.
 *
 * It belongs there rather than in a side file for the reason the transcript record does — every
 * reader of a session already reads its configuration, and a second document would be a second thing
 * to keep consistent with the first across a torn write. The two adapters are deliberately shaped
 * alike, so a reader of one recognises the other.
 *
 * THE WRITE IS A MERGE, NOT A REPLACEMENT. `updateConfig` is handed the current document and answers
 * with it plus one field, so a stamp written during a revive cannot drop a field some other writer
 * added between the read and the write.
 */

import { SessionConfigSchema } from '@ferretry/protocol';
import { type SessionId, tryParseSessionId } from '../../../lib/index.ts';
import type { SessionProvenanceRecord, SessionProvenanceStore } from '../../../lib/session/provenance/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

function fields(document: unknown): Readonly<Record<string, unknown>> {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : {};
}

export class StorageSessionProvenanceStore implements SessionProvenanceStore {
  constructor(private readonly storage: DaemonStorage) {}

  /**
   * The stamp this session carries, or `undefined` for one that carries none.
   *
   * Read through `SessionConfigSchema` rather than off the raw field, because that schema is now the
   * one home of the shape: a damaged stamp fails the whole config parse, so it reaches the recorder
   * as "no stamp" and a fresh resolution runs. Reading the raw field instead would be a second
   * parser of the same value, and the two would eventually disagree about what damaged means.
   */
  async read(sessionId: string): Promise<SessionProvenanceRecord> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return {};
    const document = await this.storage.readConfig(id).catch(() => undefined);
    if (document === undefined) return {};
    const parsed = SessionConfigSchema.safeParse(document);
    if (!parsed.success) return {};
    return {
      ...(parsed.data.provenance === undefined ? {} : { provenance: parsed.data.provenance }),
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
    };
  }

  /**
   * Merges the spawn decision into the configuration without disturbing anything else in it.
   *
   * AN ABSENT LABEL IS WRITTEN AS AN ABSENT FIELD, never as `null` or `''`. `SessionConfigSchema`
   * declares `label` optional and would refuse a null, so a session whose forced label is withdrawn
   * has to lose the key rather than gain an empty one — and a document that fails its own schema is
   * a session every surface drops.
   */
  async write(sessionId: string, record: SessionProvenanceRecord): Promise<void> {
    const id: SessionId | undefined = tryParseSessionId(sessionId);
    // An id the layout would not accept must never become a directory path. Nothing is written and
    // nothing is raised: the caller asked to record a fact about a session that cannot exist.
    if (id === undefined) return;
    await this.storage.updateConfig(id, current => {
      const { label: _dropped, ...rest } = fields(current);
      return {
        ...rest,
        ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
        ...(record.label === undefined ? {} : { label: record.label }),
      };
    });
  }
}
