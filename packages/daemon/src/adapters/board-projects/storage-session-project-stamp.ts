import { type BoardProjectId, BoardProjectIdSchema, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import type { SessionProjectStamp } from '../../lib/board-projects/index.ts';
import { jsonObject } from '../../lib/json.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/**
 * Moves a session off the Unfiled board, in `config.projectId`: the one rewrite of a stamp written at start,
 * for a ferret whose repository was registered after it started. A session already on a real board keeps it,
 * decided inside the config update so a concurrent stamp cannot be overwritten.
 */
export class StorageSessionProjectStamp implements SessionProjectStamp {
  constructor(private readonly storage: Pick<DaemonStorage, 'findSession' | 'updateConfig'>) {}

  async stamp(sessionId: string, projectId: BoardProjectId): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined || this.storage.findSession(id) === undefined) return;
    const next = BoardProjectIdSchema.parse(projectId);
    await this.storage.updateConfig(id, current => {
      const config = jsonObject(current) ?? {};
      const stamped = config.projectId;
      if (stamped !== undefined && stamped !== UNFILED_PROJECT_ID) return config;
      return { ...config, projectId: next };
    });
  }
}
