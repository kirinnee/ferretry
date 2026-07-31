import { parseSessionId } from '../../../lib/index.ts';
import type {
  SessionLifecycleEvent,
  SessionLifecycleRecord,
  SessionLifecycleRepository,
} from '../../../lib/session/lifecycle/index.ts';
import { SessionLifecycleRecordSchema } from '../../../lib/session/lifecycle/types.ts';
import { DaemonStorage } from '../../storage/session-storage.ts';

/** Stores lifecycle records in the daemon's authoritative config/state/journal triplet. */
export class StorageSessionLifecycleRepository implements SessionLifecycleRepository {
  constructor(private readonly storage: DaemonStorage) {}

  async read(id: SessionLifecycleRecord['config']['id']): Promise<SessionLifecycleRecord | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined && state === undefined) return undefined;
    return SessionLifecycleRecordSchema.parse({ config, state });
  }

  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    const id = parseSessionId(record.config.id);
    await this.storage.writeConfig(id, record.config);
    await this.storage.writeState(id, record.state);
    await this.storage.append(id, event.type, event.data);
  }
}
