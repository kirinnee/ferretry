import { z } from 'zod';
import type { HomeSession, HomeSessions } from '../../lib/agenda/home.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import { WARDEN_TERMINAL_STATUSES } from '../../lib/warden/types.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** Only the fields the home rule reads: a document with others missing still has a lineage. */
const HomeConfigSchema = z.object({
  parent: z.string().optional(),
  mode: z.string(),
  projectId: z.string().optional(),
  updatedAt: z.string(),
  provenance: z.object({ origin: z.enum(['human', 'session', 'warden']) }).optional(),
});

/** The home rule's reader over the session configuration documents; a document the schema rejects is unreadable. */
export class StorageHomeSessions implements HomeSessions {
  constructor(private readonly storage: Pick<DaemonStorage, 'findSession' | 'readConfig' | 'listSessions'>) {}

  async get(sessionId: string): Promise<HomeSession | undefined> {
    const id = tryParseSessionId(sessionId);
    const indexed = id === undefined ? undefined : this.storage.findSession(id);
    if (id === undefined || indexed === undefined) return undefined;
    const config = HomeConfigSchema.safeParse(await this.storage.readConfig(id));
    if (!config.success) return undefined;
    const { data } = config;
    return {
      id: sessionId,
      ...(data.parent === undefined ? {} : { parent: data.parent }),
      ...(data.provenance === undefined ? {} : { origin: data.provenance.origin }),
      mode: data.mode,
      ...(data.projectId === undefined ? {} : { projectId: data.projectId }),
      updatedAt: data.updatedAt,
      ...(indexed.status === undefined
        ? {}
        : { live: !(WARDEN_TERMINAL_STATUSES as readonly string[]).includes(indexed.status) }),
    };
  }

  async all(): Promise<readonly string[]> {
    return this.storage.listSessions().map(session => session.id);
  }
}
