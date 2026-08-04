import { ConversationDigestError, type TranscriptDigestJournal } from '../../../lib/session/transcript/index.ts';
import { tryParseSessionId } from '../../../lib/session-id.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** The daemon-scoped journal proof required before a transcript can become a restartable digest. */
export class StorageTranscriptDigestJournal implements TranscriptDigestJournal {
  constructor(private readonly storage: DaemonStorage) {}

  async assertReadable(sessionId: string): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `session ${sessionId} cannot name a daemon-owned journal for a restartable transcript digest`,
      );
    await this.storage.assertJournalReadable(id);
  }
}
