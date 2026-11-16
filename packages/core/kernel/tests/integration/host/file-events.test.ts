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
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { milliseconds } from '@ferretry/std';
import { systemClock } from '../../../host/adapters/clock.ts';
import {
  configTreeEvents,
  type FileEvents,
  NO_FILE_EVENTS,
  nodeFileEvents,
  polledOnly,
  undeclaredFileEvents,
} from '../../../host/adapters/file-events.ts';
import { watchConfigFiles } from '../../../host/config/watcher.ts';
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

  test('a directory that is not there is polled, but is missing rather than a platform limit, so it is not listed', async () => {
    const root = await fresh();
    const missing = join(root, 'never-made');
    const events = nodeFileEvents(systemClock(), { pollMs: milliseconds(25) });
    let heard = 0;
    const subscription = events.watchDirectory(missing, () => (heard += 1));
    expect(events.polled()).toEqual([]);
    await until(() => heard >= 3, 'three polls');
    subscription.close();
    const settled = heard;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(heard).toBe(settled);
  });

  test('a directory the platform refuses for another reason is listed, and its poll ends at close', async () => {
    const events = nodeFileEvents(systemClock(), {
      pollMs: milliseconds(25),
      watcher: () => {
        throw Object.assign(new Error('no more watches'), { code: 'EMFILE' });
      },
    });
    let heard = 0;
    const subscription = events.watchDirectory('/h/full', () => (heard += 1));
    expect(events.polled()).toEqual([{ directory: '/h/full', reason: 'EMFILE', everyMs: 25 }]);
    await until(() => heard >= 3, 'three polls');
    subscription.close();
    expect(events.polled()).toEqual([]);
  });

  test('a directory armed through a symlink is heard (it is watched on its real path)', async () => {
    const root = await fresh();
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(join(root, 'link'), () => (heard += 1));
    stops.push(() => subscription.close());
    await writeFile(join(root, 'real', 'machine.yaml'), 'a: 1\n');
    await until(() => heard > 0, 'the create through the link');
    expect(events.polled()).toEqual([]);
  });
});

describe('nodeFileEvents when the watched folder is replaced', () => {
  test('a folder deleted and recreated is watched again by recheck, and a file in the new one is heard', async () => {
    const root = await fresh();
    const folder = join(root, 'config');
    await mkdir(folder);
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(folder, () => (heard += 1));
    stops.push(() => subscription.close());
    await rm(folder, { recursive: true });
    await mkdir(folder);
    subscription.recheck();
    const afterRecheck = heard;
    await writeFile(join(folder, 'machine.yaml'), 'a: 1\n');
    await until(() => heard > afterRecheck, 'the create in the recreated folder');
  });

  test('a folder renamed away and recreated is watched again by recheck', async () => {
    const root = await fresh();
    const folder = join(root, 'config');
    await mkdir(folder);
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(folder, () => (heard += 1));
    stops.push(() => subscription.close());
    await rename(folder, join(root, 'config.old'));
    await mkdir(folder);
    subscription.recheck();
    const afterRecheck = heard;
    await writeFile(join(folder, 'machine.yaml'), 'a: 1\n');
    await until(() => heard > afterRecheck, 'the create in the recreated folder');
  });

  test('a symlinked folder retargeted after the watch began is watched again by recheck', async () => {
    const root = await fresh();
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    await symlink(join(root, 'first'), join(root, 'link'));
    const events = nodeFileEvents(systemClock());
    let heard = 0;
    const subscription = events.watchDirectory(join(root, 'link'), () => (heard += 1));
    stops.push(() => subscription.close());
    await unlink(join(root, 'link'));
    await symlink(join(root, 'second'), join(root, 'link'));
    subscription.recheck();
    const afterRecheck = heard;
    await writeFile(join(root, 'second', 'machine.yaml'), 'a: 1\n');
    await until(() => heard > afterRecheck, 'the create in the new target');
  });

  test('a recheck of a folder that did not change opens nothing and tells nobody', async () => {
    const root = await fresh();
    let armed = 0;
    const real = nodeFileEvents(systemClock(), {
      watcher: (directory, onEvent, onError) => {
        armed += 1;
        return watch(directory, { persistent: false }, () => onEvent()).on('error', onError);
      },
    });
    let heard = 0;
    const subscription = real.watchDirectory(root, () => (heard += 1));
    stops.push(() => subscription.close());
    subscription.recheck();
    subscription.recheck();
    expect(armed).toBe(1);
    expect(heard).toBe(0);
  });

  test('a folder that is missing is polled, and is watched as soon as it exists', async () => {
    const root = await fresh();
    const folder = join(root, 'later');
    const events = nodeFileEvents(systemClock(), { pollMs: milliseconds(60_000) });
    let heard = 0;
    const subscription = events.watchDirectory(folder, () => (heard += 1));
    stops.push(() => subscription.close());
    await mkdir(folder);
    subscription.recheck();
    const afterRecheck = heard;
    await writeFile(join(folder, 'machine.yaml'), 'a: 1\n');
    await until(() => heard > afterRecheck, 'the create in the folder that appeared');
  });

  test('two errors from one watch poll once, and closing ends that poll', async () => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    let closed = 0;
    watcher.close = () => {
      closed += 1;
    };
    const events = nodeFileEvents(systemClock(), {
      pollMs: milliseconds(25),
      watcher: (_directory, _onEvent, onError) => {
        watcher.on('error', onError);
        return watcher as unknown as FSWatcher;
      },
    });
    let heard = 0;
    const subscription = events.watchDirectory('/h/config', () => (heard += 1));
    watcher.emit('error', Object.assign(new Error('gone'), { code: 'EIO' }));
    watcher.emit('error', Object.assign(new Error('gone again'), { code: 'EIO' }));
    expect(closed).toBe(1);
    expect(events.polled()).toHaveLength(1);
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

describe('the config watcher re-arms a folder that was replaced', () => {
  /** A watcher whose fingerprint never moves, so a heard event can only have come from a watch, not the backstop read. */
  const watchOnly = (tree: { directories(): Promise<readonly string[]>; events: FileEvents }) => {
    let events = 0;
    const stop = watchConfigFiles({
      fingerprint: async () => 'same',
      onEvent: () => {
        events += 1;
      },
      onChange: async () => undefined,
      onError: error => {
        throw error;
      },
      timers: { setInterval, clearInterval, setTimeout, clearTimeout },
      events: configTreeEvents(tree.events, tree.directories),
      intervalMs: 100,
    });
    stops.push(stop);
    return { events: () => events };
  };

  test('a folder deleted and recreated: after the backstop tick an edit in it is heard at once, not at the next tick', async () => {
    const root = await fresh();
    const folder = join(root, 'config');
    await mkdir(folder);
    const real = nodeFileEvents(systemClock());
    const watcher = watchOnly({ events: real, directories: async () => [folder] });
    await new Promise(resolve => setTimeout(resolve, 150));
    await rm(folder, { recursive: true });
    await mkdir(folder);
    await new Promise(resolve => setTimeout(resolve, 350));
    const before = watcher.events();
    await writeFile(join(folder, 'machine.yaml'), 'a: 1\n');
    await until(() => watcher.events() > before, 'the event from the re-armed watch');
  });

  test('a symlinked folder retargeted: after the backstop tick an edit in the new target is heard', async () => {
    const root = await fresh();
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    await symlink(join(root, 'first'), join(root, 'link'));
    const real = nodeFileEvents(systemClock());
    const watcher = watchOnly({ events: real, directories: async () => [join(root, 'link')] });
    await new Promise(resolve => setTimeout(resolve, 150));
    await unlink(join(root, 'link'));
    await symlink(join(root, 'second'), join(root, 'link'));
    await new Promise(resolve => setTimeout(resolve, 350));
    const before = watcher.events();
    await writeFile(join(root, 'second', 'machine.yaml'), 'a: 1\n');
    await until(() => watcher.events() > before, 'the event from the re-armed watch');
  });
});

describe('what a plugin is handed of the file events', () => {
  const polled = [{ directory: '/h/a', reason: 'EMFILE', everyMs: 1_000 }];

  test('only the list: the port polledOnly builds has no watch to call', () => {
    const real = nodeFileEvents(systemClock());
    const port = polledOnly({ ...real, polled: () => polled });
    expect(port.polled()).toEqual(polled);
    expect(Object.keys(port)).toEqual(['polled']);
  });

  test('a plugin that did not declare it is refused by name, and a host with no adapter lists nothing', () => {
    expect(() => undeclaredFileEvents('other').polled()).toThrow('other did not declare permissions.fileEvents');
    expect(NO_FILE_EVENTS.polled()).toEqual([]);
  });
});

describe('configTreeEvents', () => {
  test('lists the folders it was given and subscribes each through the file events', async () => {
    const seen: string[] = [];
    const events: FileEvents = {
      polled: () => [],
      watchDirectory: directory => {
        seen.push(directory);
        return { close: () => undefined, recheck: () => undefined };
      },
    };
    const tree = configTreeEvents(events, async () => ['/h/config', '/h/config/logins']);
    expect(await tree.directories()).toEqual(['/h/config', '/h/config/logins']);
    tree.subscribeDirectory('/h/config/logins', () => undefined);
    expect(seen).toEqual(['/h/config/logins']);
  });
});
