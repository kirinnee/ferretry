/**
 * The world the session-index rebuild tests (BG-049, J-0159) stand in: a fleet of generated sessions written through
 * `DaemonStorage`, and the boot after the cache file (`index.sqlite`) was lost — the same documents, no index.
 */
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { FerretIndexFile } from '../../../contract/index.ts';
import type { KeyedSerialExecutor } from '../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId, type SessionId } from '../../../daemon/lib/session-id.ts';
import { memoryStorage, type MemoryStorage, SESSION_STORE_FILES, sessionConfig, sessionState } from './storage.ts';

/** The nth generated session id: `ses-000`, `ses-001`, … */
export const sessionIdAt = (position: number): SessionId => parseSessionId(`ses-${String(position).padStart(3, '0')}`);

/** A cache file with nothing in it: what a lost `index.sqlite` gives the next boot. */
export const emptyCache = (): SessionIndex =>
  new ListedSessionIndex(
    new StateSqliteIndex(new MemoryStateFolder().port(SESSION_STORE_FILES).sqlite(FerretIndexFile)),
  );

/** `count` sessions written through the storage — a config, a state and two journal events each — deterministically. */
export async function generatedFleet(count: number, folder?: MemoryStateFolder): Promise<MemoryStorage> {
  const world = await memoryStorage(folder === undefined ? {} : { folder });
  for (let position = 0; position < count; position += 1) {
    const id = sessionIdAt(position);
    await world.storage.writeConfig(id, sessionConfig(id));
    await world.storage.writeState(id, sessionState(id));
    await world.storage.append(id, 'note', { n: 1 });
    await world.storage.append(id, 'note', { n: 2 });
  }
  return world;
}

/** The same files, a new storage, and no cache: the boot after the cache was lost. */
export async function restartWithCacheLost(world: MemoryStorage, serial?: KeyedSerialExecutor): Promise<MemoryStorage> {
  await world.storage.close();
  return await memoryStorage({ folder: world.folder, index: emptyCache, ...(serial === undefined ? {} : { serial }) });
}
