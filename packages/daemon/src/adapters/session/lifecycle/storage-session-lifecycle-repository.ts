import { parseSessionId, type SessionId } from '../../../lib/index.ts';
import type {
  SessionLifecycleEvent,
  SessionLifecycleRecord,
  SessionLifecycleRepository,
} from '../../../lib/session/lifecycle/index.ts';
import { SessionLifecycleRecordSchema } from '../../../lib/session/lifecycle/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** Raised instead of a raw parse error, so a caller can tell a broken record from a missing one. */
export class UnusableSessionRecordError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly reason: string,
  ) {
    super(`session record ${sessionId} is unusable: ${reason}`);
    this.name = 'UnusableSessionRecordError';
  }
}

/** Stores lifecycle records in the daemon's authoritative config/state/journal triplet. */
export class StorageSessionLifecycleRepository implements SessionLifecycleRepository {
  constructor(private readonly storage: DaemonStorage) {}

  async read(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined && state === undefined) return undefined;
    if (config === undefined) throw new UnusableSessionRecordError(id, 'its configuration document is missing');
    // `write` persists the configuration first, so a config with no state is a create that tore
    // between the two writes: nothing was ever launched, and the session is recoverable as
    // `created` rather than throwing on every later read — which would leave its pane unstoppable.
    const parsed = SessionLifecycleRecordSchema.safeParse({ config, state: state ?? { id, status: 'created' } });
    if (!parsed.success)
      throw new UnusableSessionRecordError(
        id,
        parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      );
    return parsed.data;
  }

  /**
   * Configuration, then state, then the journal. The order is the recovery contract: a tear can
   * only ever lose the *later* write, so it leaves the session one transition behind — never a
   * state whose configuration is missing, and never an event claiming a state that is not durable.
   */
  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    const id = parseSessionId(record.config.id);
    await this.storage.writeConfig(id, record.config);
    await this.storage.writeState(id, record.state);
    await this.storage.append(id, event.type, event.data);
  }
}
