/**
 * The kernel's file events on a real disk: Bun's `fs.watch` on a directory tells the listener something changed, a
 * directory the platform will not watch is polled instead and named, and the config service reloads on an event.
 *
 * Linux is where this ran. macOS answers a directory with FSEvents (Bun's `fs_events.zig`), which merges and delays
 * events differently; every assertion here waits for the event rather than for a count, so the file is meant to be run
 * on a Mac as well (the end list of the c58-67 brief).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { milliseconds } from '@ferretry/std';
import { systemClock } from '../../../host/adapters/clock.ts';
import { configTreeEvents, type FileEvents, nodeFileEvents } from '../../../host/adapters/file-events.ts';
import { configService } from '../../../host/wiring.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { captureLog, updatesDef } from '../../unit/host-config/support.ts';

const roots: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fresh = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-kernel-file-events-'));
  roots.push(root);
  return root;
};

/** Wait until `done` holds, failing with `what` after five seconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('nodeFileEvents on a real directory', () => {
  test('a file created in a watched directory is heard, and nothing is polled', async () => {
    const root = await fresh();
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(root, () => (heard += 1));
    stops.push(() => subscription.close());
    await writeFile(join(root, 'machine.yaml'), 'a: 1\n');
    await until(() => heard > 0, 'the create');
    expect(events.polled()).toEqual([]);
  });

  test('a file renamed into a watched directory is heard, as an editor saves through a temporary file', async () => {
    const root = await fresh();
    await writeFile(join(root, '.machine.yaml.tmp'), 'a: 1\n');
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(root, () => (heard += 1));
    stops.push(() => subscription.close());
    await rename(join(root, '.machine.yaml.tmp'), join(root, 'machine.yaml'));
    await until(() => heard > 0, 'the rename');
  });

  test('a closed subscription hears nothing more, and closing twice is harmless', async () => {
    const root = await fresh();
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(root, () => (heard += 1));
    subscription.close();
    subscription.close();
    await writeFile(join(root, 'late.yaml'), 'a: 1\n');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(heard).toBe(0);
  });

  test('a directory that is not there is polled instead, named by its error code, and its poll ends at close', async () => {
    const root = await fresh();
    const missing = join(root, 'never-made');
    const events = nodeFileEvents(systemClock(), { pollMs: milliseconds(25) });
    let heard = 0;
    const subscription = events.watchDirectory(missing, () => (heard += 1));
    expect(events.polled()).toEqual([{ directory: missing, reason: 'ENOENT', everyMs: 25 }]);
    await until(() => heard >= 3, 'three polls');
    subscription.close();
    expect(events.polled()).toEqual([]);
    const settled = heard;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(heard).toBe(settled);
  });
});

describe('nodeFileEvents when the platform watch dies', () => {
  /** A watch the test can kill: the way Bun reports a watch that stopped (`error` on the watcher). */
  const dying = () => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    let closed = 0;
    watcher.close = () => {
      closed += 1;
    };
    return { watcher, closedCount: () => closed };
  };

  test('a watch that dies after it opened is closed and the directory is polled from then on, looking once at once', async () => {
    const { watcher, closedCount } = dying();
    const events = nodeFileEvents(systemClock(), {
      pollMs: milliseconds(25),
      watcher: (_directory, _onEvent, onError) => {
        watcher.on('error', onError);
        return watcher as unknown as FSWatcher;
      },
    });
    let heard = 0;
    const subscription = events.watchDirectory('/h/config', () => (heard += 1));
    expect(events.polled()).toEqual([]);
    watcher.emit('error', Object.assign(new Error('gone'), { code: 'EIO' }));
    expect(closedCount()).toBe(1);
    expect(events.polled()).toEqual([{ directory: '/h/config', reason: 'EIO', everyMs: 25 }]);
    expect(heard).toBe(1);
    await until(() => heard >= 3, 'the polls');
    subscription.close();
    expect(events.polled()).toEqual([]);
  });

  test('a watch that dies after it was closed is ignored, and an error with no code is named failed', () => {
    const first = dying();
    const second = dying();
    const queue = [first.watcher, second.watcher];
    const events = nodeFileEvents(systemClock(), {
      pollMs: milliseconds(25),
      watcher: (_directory, _onEvent, onError) => {
        const watcher = queue.shift() as EventEmitter & { close(): void };
        watcher.on('error', onError);
        return watcher as unknown as FSWatcher;
      },
    });
    const closedOne = events.watchDirectory('/h/a', () => undefined);
    closedOne.close();
    first.watcher.emit('error', new Error('late'));
    expect(first.closedCount()).toBe(1);
    expect(events.polled()).toEqual([]);
    const open = events.watchDirectory('/h/b', () => undefined);
    second.watcher.emit('error', 'not an error object');
    expect(events.polled()).toEqual([{ directory: '/h/b', reason: 'failed', everyMs: 25 }]);
    open.close();
  });
});

describe('configService over real file events', () => {
  test('the watcher is armed on every folder of the tree, and an edit is loaded from the event', async () => {
    const home = await fresh();
    const real = nodeFileEvents(systemClock());
    const watched: string[] = [];
    const spy: FileEvents = {
      polled: () => real.polled(),
      watchDirectory: (directory, listener) => {
        watched.push(directory);
        return real.watchDirectory(directory, listener);
      },
    };
    const config = configService(
      home,
      createNodeHostFs(),
      systemClock(),
      captureLog(),
      'fy',
      spy,
    )([{ plugin: 'updates', def: updatesDef }]);
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'updates.yaml'), 'limit: 3\n');
    await config.reload();
    const stop = config.startWatching?.();
    stops.push(() => stop?.());
    await until(() => watched.includes(join(home, 'config')), 'the config folder to be watched');
    await writeFile(join(home, 'config', 'updates.yaml'), 'limit: 2\n');
    await until(() => (config.port('updates').file(updatesDef) as { limit: number }).limit === 2, 'the reload');
    expect(spy.polled()).toEqual([]);
  });

  test('without file events the service still arms its watcher and polls', async () => {
    const home = await fresh();
    const config = configService(
      home,
      createNodeHostFs(),
      systemClock(),
      captureLog(),
      'fy',
    )([{ plugin: 'updates', def: updatesDef }]);
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'updates.yaml'), 'limit: 3\n');
    await config.reload();
    const stop = config.startWatching?.();
    stops.push(() => stop?.());
    await writeFile(join(home, 'config', 'updates.yaml'), 'limit: 2\n');
    await until(() => (config.port('updates').file(updatesDef) as { limit: number }).limit === 2, 'the polled reload');
  });
});

describe('configTreeEvents', () => {
  test('lists the folders it was given and subscribes each through the file events', async () => {
    const seen: string[] = [];
    const events: FileEvents = {
      polled: () => [],
      watchDirectory: directory => {
        seen.push(directory);
        return { close: () => undefined };
      },
    };
    const tree = configTreeEvents(events, async () => ['/h/config', '/h/config/logins']);
    expect(await tree.directories()).toEqual(['/h/config', '/h/config/logins']);
    tree.subscribeDirectory('/h/config/logins', () => undefined);
    expect(seen).toEqual(['/h/config/logins']);
  });
});
