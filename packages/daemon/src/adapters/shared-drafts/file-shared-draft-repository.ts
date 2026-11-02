import { join } from 'node:path';
import { type AgendaId, AgendaIdSchema, type SharedDraftSnapshot, SharedDraftSnapshotSchema } from '@ferretry/protocol';
import type { FileSystemPort, FoundationPaths, SerialExecutor } from '../../lib/index.ts';
import type { SharedDraftRepository } from '../../lib/shared-drafts/index.ts';

/**
 * One small file per draft under `state/shared-drafts/`, written atomically and owner-only (`0600`,
 * like every state file). It holds the draft's words while they are unsent; once a send empties the
 * draft the file keeps only the epoch, so sent text does not linger on disk.
 *
 * A SESSION'S CHAT DRAFT is `<session>.json`, the file it has always been. Each AGENDA ITEM's draft is its
 * own file beside it, `<session>.items/<item>.json`: a different name, so no old file is ever read as an item
 * draft, and an item's file is deleted outright when its item closes.
 *
 * DELIBERATELY NOT IN THE SESSION'S OWN FOLDER. That folder is what agents are pointed at and what the
 * miners and importers walk, so it is the likeliest place for unsent words to be read by accident. And a
 * late write for a session folder removed by hand would recreate it holding nothing but this file, which
 * storage would then take for a damaged session.
 */
export function sharedDraftFile(paths: FoundationPaths, sessionId: string, slot?: AgendaId): string {
  return slot === undefined
    ? join(paths.state, 'shared-drafts', `${sessionId}.json`)
    : join(sharedDraftItemsDirectory(paths, sessionId), `${slot}.json`);
}

function sharedDraftItemsDirectory(paths: FoundationPaths, sessionId: string): string {
  return join(paths.state, 'shared-drafts', `${sessionId}.items`);
}

export class FileSharedDraftRepository implements SharedDraftRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    // Per draft, so two writes of one draft land in the order they were made.
    private readonly executor: SerialExecutor,
  ) {}

  async load(sessionId: string, slot?: AgendaId): Promise<SharedDraftSnapshot | undefined> {
    const text = await this.files.readText(sharedDraftFile(this.paths, sessionId, slot));
    if (text === undefined) return undefined;
    try {
      const result = SharedDraftSnapshotSchema.safeParse(JSON.parse(text));
      // A damaged or foreign file is not this draft; starting empty is the honest answer. An item file that
      // names another slot (or none) is just as foreign.
      return result.success && result.data.sessionId === sessionId && result.data.slot === slot
        ? result.data
        : undefined;
    } catch {
      return undefined;
    }
  }

  async save(snapshot: SharedDraftSnapshot): Promise<void> {
    await this.executor.run(this.#lane(snapshot.sessionId, snapshot.slot), async () => {
      await this.files.writeTextAtomic(
        sharedDraftFile(this.paths, snapshot.sessionId, snapshot.slot),
        JSON.stringify(snapshot),
      );
    });
  }

  async remove(sessionId: string, slot: AgendaId): Promise<void> {
    await this.executor.run(this.#lane(sessionId, slot), async () => {
      await this.files.removeFile(sharedDraftFile(this.paths, sessionId, slot));
    });
  }

  async items(sessionId: string): Promise<readonly AgendaId[]> {
    const entries = await this.files.listDirectory(sharedDraftItemsDirectory(this.paths, sessionId)).catch(() => []);
    const items: AgendaId[] = [];
    for (const entry of entries) {
      if (entry.regularFile !== true || !entry.name.endsWith('.json')) continue;
      const id = AgendaIdSchema.safeParse(entry.name.slice(0, -'.json'.length));
      if (id.success) items.push(id.data);
    }
    return items;
  }

  /** The executor lane one draft's writes share; the chat draft keeps the session id it has always used. */
  #lane(sessionId: string, slot: AgendaId | undefined): string {
    return slot === undefined ? sessionId : `${sessionId}\u0000${slot}`;
  }
}
