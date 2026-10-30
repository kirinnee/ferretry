import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { AutoTitlingSendChannel } from '../../../src/adapters/names/index.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import type { InboundMessage, SendChannel } from '../../../src/lib/session/send/types.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

/**
 * The first-message title, over a REAL session document: the config the daemon reads back after a send
 * is what the sidebar will show, so the write has to survive the storage round trip.
 */

const NOW = '2026-10-30T09:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function openTemporaryStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-auto-title-'));
  directories.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

const inner: SendChannel = {
  recordInbound: async () => undefined,
  recordOutbound: async () => undefined,
};

const message = (extra: Partial<InboundMessage> = {}): InboundMessage => ({
  at: NOW,
  message: 'Fix the sidebar titles',
  ...extra,
});

const configuration = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: 'interactive',
  nameSource: 'auto',
  agent: 'claude',
  harness: 'claude',
  mode: 'interactive',
  cwd: '/work/repo',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

describe('AutoTitlingSendChannel over real storage', () => {
  it('should title a placeholder-named session from its first owner message, once', async () => {
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20261030-first');
    await storage.writeConfig(id, configuration(id));
    const channel = new AutoTitlingSendChannel(inner, storage);

    await channel.recordInbound(id, message());
    await channel.recordInbound(id, message({ message: 'And another thing' }));

    should(await storage.readConfig(id)).containEql({ name: 'Fix the sidebar titles', nameSource: 'auto' });
  });

  it('should leave an owner-named session and a teammate message alone', async () => {
    const storage = await openTemporaryStorage();
    const owned = parseSessionId('20261030-owned');
    const other = parseSessionId('20261030-other');
    await storage.writeConfig(owned, configuration(owned, { name: 'Mine', nameSource: 'owner' }));
    await storage.writeConfig(other, configuration(other));
    const channel = new AutoTitlingSendChannel(inner, storage);

    await channel.recordInbound(owned, message());
    await channel.recordInbound(other, message({ from: 'hadi' }));

    should(await storage.readConfig(owned)).containEql({ name: 'Mine', nameSource: 'owner' });
    should(await storage.readConfig(other)).containEql({ name: 'interactive' });
  });

  it('should not fail the send for a session it cannot find or a title it cannot write', async () => {
    const storage = await openTemporaryStorage();
    const missing = parseSessionId('20261030-missing');
    const broken = parseSessionId('20261030-broken');
    await storage.writeConfig(broken, configuration(broken));
    const failing = new Proxy(storage, {
      get: (target, property) =>
        property === 'readConfig'
          ? async () => {
              throw new Error('disk gone');
            }
          : (Reflect.get(target, property) as unknown),
    });

    await new AutoTitlingSendChannel(inner, storage).recordInbound(missing, message());
    await new AutoTitlingSendChannel(inner, failing).recordInbound(broken, message());

    should(await storage.readConfig(broken)).containEql({ name: 'interactive' });
  });
});
