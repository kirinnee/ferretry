import { join } from 'node:path';
import { type SharedDraftSnapshot, SharedDraftSnapshotSchema } from '@ferretry/protocol';
import type { FileSystemPort, FoundationPaths, SerialExecutor } from '../../lib/index.ts';
import type { SharedDraftRepository } from '../../lib/shared-drafts/index.ts';

/**
 * One small file per session under `state/shared-drafts/`, written atomically and owner-only (`0600`,
 * like every state file). It holds the draft's words while they are unsent; once a send empties the
 * draft the file keeps only the epoch, so sent text does not linger on disk.
 *
 * DELIBERATELY NOT IN THE SESSION'S OWN FOLDER. That folder is what agents are pointed at and what the
 * miners and importers walk, so it is the likeliest place for unsent words to be read by accident. And a
 * late write for a session folder removed by hand would recreate it holding nothing but this file, which
 * storage would then take for a damaged session.
 */
export function sharedDraftFile(paths: FoundationPaths, sessionId: string): string {
  return join(paths.state, 'shared-drafts', `${sessionId}.json`);
}

export class FileSharedDraftRepository implements SharedDraftRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    // Per session, so two writes of one draft land in the order they were made.
    private readonly executor: SerialExecutor,
  ) {}

  async load(sessionId: string): Promise<SharedDraftSnapshot | undefined> {
    const text = await this.files.readText(sharedDraftFile(this.paths, sessionId));
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
      await this.files.writeTextAtomic(sharedDraftFile(this.paths, snapshot.sessionId), JSON.stringify(snapshot));
    });
  }
}
