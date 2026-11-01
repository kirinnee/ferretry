import { join } from 'node:path';
import { type SharedDraftSnapshot, SharedDraftSnapshotSchema } from '@ferretry/protocol';
import type { FileSystemPort, FoundationPaths, SerialExecutor } from '../../lib/index.ts';
import type { SharedDraftRepository } from '../../lib/shared-drafts/index.ts';

/**
 * One small file per session, beside the session's own state, written atomically and owner-only
 * (`0600`, like every state file). It holds the draft's words while they are unsent; once a send
 * empties the draft the file keeps only the epoch, so sent text does not linger on disk.
 */
function draftFile(paths: FoundationPaths, sessionId: string): string {
  return join(paths.sessions, sessionId, 'shared-draft.json');
}

export class FileSharedDraftRepository implements SharedDraftRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    // Per session, so two writes of one draft land in the order they were made.
    private readonly executor: SerialExecutor,
  ) {}

  async load(sessionId: string): Promise<SharedDraftSnapshot | undefined> {
    const text = await this.files.readText(draftFile(this.paths, sessionId));
    if (text === undefined) return undefined;
    try {
      const result = SharedDraftSnapshotSchema.safeParse(JSON.parse(text));
      // A damaged or foreign file is not this session's draft; starting empty is the honest answer.
      return result.success && result.data.sessionId === sessionId ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  async save(snapshot: SharedDraftSnapshot): Promise<void> {
    await this.executor.run(snapshot.sessionId, async () => {
      await this.files.writeTextAtomic(draftFile(this.paths, snapshot.sessionId), JSON.stringify(snapshot));
    });
  }
}
