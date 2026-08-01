import { type TranscriptProvenance, TranscriptProvenanceSchema } from '@ferretry/protocol';
import { type SessionId, tryParseSessionId } from '../../../lib/index.ts';
import type { TranscriptClaims, TranscriptProvenanceStore } from '../../../lib/session/transcript/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/**
 * The provenance record's durable home: the session's own configuration document.
 *
 * It belongs there rather than in a side file because every reader of a transcript already reads
 * the configuration — the session list, the migration preflight, analytics — and a second document
 * would be a second thing to keep consistent with the first across a torn write.
 */

function fields(document: unknown): Readonly<Record<string, unknown>> {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : {};
}

/** The provenance a stored configuration carries, parsed rather than trusted. */
export function storedTranscriptProvenance(config: unknown): TranscriptProvenance | undefined {
  const parsed = TranscriptProvenanceSchema.safeParse(fields(config).transcript);
  return parsed.success ? parsed.data : undefined;
}

/** Merges a resolved record into the configuration without disturbing anything else in it. */
export class StorageTranscriptProvenanceStore implements TranscriptProvenanceStore {
  constructor(private readonly storage: DaemonStorage) {}

  async record(sessionId: string, provenance: TranscriptProvenance): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    await this.storage.updateConfig(id, current => ({ ...fields(current), transcript: provenance }));
  }
}

/**
 * Which harness sessions are already attributed, so no rollout is claimed by two sessions.
 *
 * The hazard is real rather than theoretical: a correlation token is a string in a file, and a
 * teammate that was told to read another session's directory would carry that path in its own
 * transcript. Excluding what is already attributed means the first session to be resolved keeps its
 * rollout and the second is refused rather than silently overwriting the attribution.
 */
export class StorageTranscriptClaims implements TranscriptClaims {
  constructor(private readonly storage: DaemonStorage) {}

  async claimed(exceptSessionId: string): Promise<readonly string[]> {
    const except: SessionId | undefined = tryParseSessionId(exceptSessionId);
    const ids = await Promise.all(
      this.storage.listSessions().map(async (indexed): Promise<string | undefined> => {
        if (indexed.id === except) return undefined;
        const provenance = storedTranscriptProvenance(await this.storage.readConfig(indexed.id).catch(() => undefined));
        return provenance?.identity === 'correlated' ? provenance.harnessSessionId : undefined;
      }),
    );
    return ids.filter((id): id is string => id !== undefined);
  }
}
