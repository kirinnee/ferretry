import type { Redaction } from '@ferretry/kernel/contract';
import type { FerretId } from '../../../../contract/index.ts';
import { type SessionId, tryParseSessionId } from '../../session-id.ts';
import { maskedScreen } from './screen-mask.ts';
import type { LastSnapshotReader } from './types.ts';

/** What a stored last-screen read is built from. */
export interface LastSnapshotReadingDeps {
  /** The reader for ONE ferret's own folder on the sessions root. */
  readonly store: (ferret: SessionId) => LastSnapshotReader;
  /** The Vault's read-scoped masker. */
  readonly redaction: Pick<Redaction, 'read'>;
  /** Gives the event loop back between a big screen's masking readings; absent: no yield. */
  readonly yieldToLoop?: () => Promise<void>;
}

/**
 * A stopped ferret's stored last screen, read back for a reader (`FerretsApi.lastSnapshot`).
 *
 * MASKED AGAIN ON EVERY READ. The file holds what was masked when the frame was KEPT; a value added to the Vault after
 * that is not masked in it. So the text is run through {@link maskedScreen} inside one `Redaction.read` with the
 * Vault's values NOW, and only that is handed on: the raw file text never leaves this class.
 *
 * FAILS CLOSED AND TOTAL. A frame that is absent, unreadable or damaged (the store says so), a screen the masker
 * refuses (too large) and a masker that throws all answer `undefined`: never the stored text, never an error (an error
 * could quote the screen or a path). A frame that masks to nothing is no frame either.
 */
export class LastSnapshotReading {
  constructor(private readonly deps: LastSnapshotReadingDeps) {}

  async read(ferret: FerretId): Promise<string | undefined> {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return undefined;
    try {
      const stored = await this.deps.store(id).read(id);
      if (stored.kind !== 'read') return undefined;
      const masked = await this.deps.redaction.read(scope => maskedScreen(scope, stored.text, this.deps.yieldToLoop));
      return masked.trim() === '' ? undefined : masked;
    } catch {
      return undefined;
    }
  }
}
