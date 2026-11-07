// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import { unrefFileEventTimers } from '../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../src/adapters/file-events/platform.ts';
import { FileEventHub } from '../../src/lib/file-events/hub.ts';
import { createSessionPaths, type FileSystemPort, type FoundationPaths, parseSessionId } from '../../src/lib/index.ts';

const homes: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const ID = parseSessionId('watched-1');

describe('a watched session document', () => {
  it('should see an edit from outside the daemon within the real hub’s settle, after reads that cost nothing', async () => {
    // Arrange — the real file-event hub, on this platform's watcher.
    const hub = new FileEventHub(platformFileEventSource(), unrefFileEventTimers);
    closers.push(() => hub.close());
    const home = await mkdtemp(join(tmpdir(), 'fy-document-watch-'));
    homes.push(home);
    const factory = new DaemonStorageFactory(
      new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
      { create: (paths: FoundationPaths): FileSystemPort => new StateFileSystem(paths) },
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(),
      new SystemClock(),
      () => new KeyedSerialExecutor(),
      { subscribe: (path, listener) => hub.subscribe(path, () => listener()) },
    );
    const opened = await factory.open();
    closers.push(async () => await opened.storage.close().catch(() => undefined));
    const storage = opened.storage as DaemonStorage;
    await storage.writeConfig(ID, { id: 'watched-1', status: 'running', turn: 1 });
    await storage.writeState(ID, { id: 'watched-1', status: 'running', turn: 1 });
    await storage.append(ID, 'session.created', {});
    const paths = createSessionPaths(opened.paths, ID);
    await storage.readConfig(ID, 'heard');
    // The hub's first check reports a new subscription once; let it, so the edit below is the only change.
    await writeFile(join(paths.directory, 'nudge'), 'x');
    await Bun.sleep(200);
    await storage.readConfig(ID, 'heard');

    // Act — an editor saves the file atomically, as most do.
    const temporary = join(paths.directory, 'config.json.edit');
    await writeFile(temporary, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    await rename(temporary, paths.config);
    const started = Date.now();
    let seen: unknown;
    while (Date.now() - started < 2_000) {
      seen = ((await storage.readConfig(ID, 'heard')) as Record<string, unknown>).status;
      if (seen === 'stopped') break;
      await Bun.sleep(5);
    }

    // Assert
    should(seen).equal('stopped');
    should(Date.now() - started).be.below(1_000);
  });
});
