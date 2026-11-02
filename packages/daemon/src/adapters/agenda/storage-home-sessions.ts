import { SessionConfigSchema } from '@ferretry/protocol';
import type { HomeSession, HomeSessions } from '../../lib/agenda/home.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** The home rule's reader over the session configuration documents; a document the schema rejects is unreadable. */
export class StorageHomeSessions implements HomeSessions {
  constructor(private readonly storage: Pick<DaemonStorage, 'findSession' | 'readConfig' | 'listSessions'>) {}

  async get(sessionId: string): Promise<HomeSession | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined || this.storage.findSession(id) === undefined) return undefined;
    const config = SessionConfigSchema.safeParse(await this.storage.readConfig(id));
    if (!config.success) return undefined;
    const { data } = config;
    return {
      id: sessionId,
      ...(data.parent === undefined ? {} : { parent: data.parent }),
      ...(data.provenance === undefined ? {} : { origin: data.provenance.origin }),
      mode: data.mode,
      ...(data.projectId === undefined ? {} : { projectId: data.projectId }),
      updatedAt: data.updatedAt,
    };
  }

  async all(): Promise<readonly string[]> {
    return this.storage.listSessions().map(session => session.id);
  }
}
