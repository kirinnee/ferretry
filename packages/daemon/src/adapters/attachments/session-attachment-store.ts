import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlannedAttachmentFile } from '../../lib/attachments/index.ts';

/**
 * The files an opening message attached, written into the session's own private directory.
 *
 * IT ONLY WRITES. What each file is, where it goes and what the agent is told about it were all
 * decided in memory by `planInitialAttachments` — which is what lets the start compose the opening
 * message before the session record exists and put the bytes on disk after it does. Storage refuses
 * to adopt a session directory that already holds files it did not create, so that ordering is not
 * a preference.
 *
 * Each write is atomic through a unique temporary name, for the same reason the turn-one store's is:
 * a torn write must never leave a half file the agent opens as if it were whole.
 */
export class FileSessionAttachmentStore {
  constructor(private readonly uniqueId: () => string) {}

  async write(files: readonly PlannedAttachmentFile[]): Promise<void> {
    for (const planned of files) {
      await mkdir(dirname(planned.file), { recursive: true, mode: 0o700 });
      const temporary = `${planned.file}.${this.uniqueId()}.tmp`;
      await writeFile(temporary, planned.contents, { mode: 0o600 });
      await rename(temporary, planned.file);
    }
  }
}
