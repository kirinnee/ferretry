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

/** What a config says of a session's home, without the one field that follows the index row. */
type HomeFields = Omit<HomeSession, 'live'>;

/** The home rule's reader over the session configuration documents; a document the schema rejects is unreadable. */
export class StorageHomeSessions implements HomeSessions {
  /**
   * What each config said, keyed by the frozen document the storage handed out. The storage hands back the SAME
   * object while the file is unchanged and a new one once it changes, so a hit is exact and a change is always seen;
   * only `live` follows the index row, and is read fresh on every call. A rejected document is remembered too.
   */
  private readonly parsed = new WeakMap<object, HomeFields | null>();

  constructor(private readonly storage: Pick<DaemonStorage, 'findSession' | 'readConfig' | 'listSessions'>) {}

  async get(sessionId: string): Promise<HomeSession | undefined> {
    const id = tryParseSessionId(sessionId);
    const indexed = id === undefined ? undefined : this.storage.findSession(id);
    if (id === undefined || indexed === undefined) return undefined;
    const fields = this.fieldsOf(sessionId, await this.storage.readConfig(id));
    if (fields === null) return undefined;
    return {
      ...fields,
      ...(indexed.status === undefined
        ? {}
        : { live: !(WARDEN_TERMINAL_STATUSES as readonly string[]).includes(indexed.status) }),
    };
  }

  private fieldsOf(sessionId: string, document: unknown): HomeFields | null {
    const keyed = typeof document === 'object' && document !== null;
    const known = keyed ? this.parsed.get(document) : undefined;
    if (known !== undefined && (known === null || known.id === sessionId)) return known;
    const config = HomeConfigSchema.safeParse(document);
    const fields: HomeFields | null = config.success
      ? {
          id: sessionId,
          ...(config.data.parent === undefined ? {} : { parent: config.data.parent }),
          ...(config.data.provenance === undefined ? {} : { origin: config.data.provenance.origin }),
          mode: config.data.mode,
          ...(config.data.projectId === undefined ? {} : { projectId: config.data.projectId }),
          updatedAt: config.data.updatedAt,
        }
      : null;
    if (keyed) this.parsed.set(document, fields);
    return fields;
  }

  async all(): Promise<readonly string[]> {
    return this.storage.listSessions().map(session => session.id);
  }
}
