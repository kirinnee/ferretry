/**
 * The hub over a real file-event source on the real file system: the scenarios every source must pass.
 * Each test works in a private directory INSIDE its temp root, so the parent the hub also watches holds
 * nothing but that directory (a shared temp directory holds sockets, which Bun's `fs.watch` dies on), and
 * makes the change it asserts on only once the watch that must hear it is proved {@link armed}.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { unrefFileEventTimers } from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { FileEventHub } from '../../../src/lib/file-events/hub.ts';
import type { FileEventSource } from '../../../src/lib/file-events/ports.ts';

const roots: string[] = [];
const hubs: FileEventHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

/** A fresh, empty directory whose parent is private to the test. */
export async function workspace(): Promise<string> {
  // The real path: macOS's temporary directory is behind a symbolic link (/var → /private/var), and a
  // watch should be asked for the path the daemon's own paths would name.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ferretry-file-events-'));
  roots.push(root);
  const directory = join(root, 'w');
  await mkdir(directory);
  return directory;
}

/** Whether `done` came to hold within `ms`. */
async function within(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(5);
  }
  return true;
}

/** Wait until `done` holds, failing after a generous bound: real events arrive on the kernel's schedule. */
export async function until(done: () => boolean, what: string, ms = 3_000): Promise<void> {
  if (!(await within(done, ms))) throw new Error(`timed out waiting for ${what}`);
}

export function hubOver(source: FileEventSource): FileEventHub {
  const hub = new FileEventHub(source, unrefFileEventTimers, { settleMs: 10, pollMs: 50 });
  hubs.push(hub);
  return hub;
}

/** How long a probe goes unheard before another is written: an armed watch reports one well inside it. */
const PROBE_MS = 250;

/**
 * Prove that the watch on `directory` hears a change NOW — which a watch that has merely opened has not.
 *
 * On macOS Bun runs ONE FSEvents stream for every directory the process watches. `fs.watch` adds the path
 * and only QUEUES a rebuild of that stream on Bun's CoreFoundation thread (`registerWatcher` → `_schedule`
 * in `src/bun.js/node/fs_events.zig`, Bun 1.3.13), returning before it runs, and the rebuilt stream starts
 * at `kFSEventStreamEventIdSinceNow`: a change made before it is registered is reported by no stream — not
 * late, never. In an idle process that window is too short to hit; on a loaded runner a test that writes
 * as soon as it subscribes falls into it, which is the Containment (macOS) job's "timed out waiting for the
 * first report". Bun says nothing when the rebuild has run, so the one readiness signal is a change heard.
 *
 * So a probe file in `directory` is written until the hub reports it, TWICE: the first report may be the
 * look the hub takes at once after RE-opening a watch, which stats rather than hears, and a probe written
 * after that look is reported only once something saw it change. Each probe is longer than the last, so
 * it changes the file's stamp however coarse the clock. inotify, and Bun off macOS, arm before returning.
 */
export async function armed(hub: FileEventHub, directory: string): Promise<void> {
  const probe = join(directory, 'probe');
  let reports = 0;
  const subscription = hub.subscribe(probe, () => {
    reports += 1;
  });
  try {
    const deadline = Date.now() + 3_000;
    let written = 0;
    for (const wanted of [1, 2]) {
      while (reports < wanted) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the watch to hear a probe');
        written += 1;
        await writeFile(probe, 'x'.repeat(written));
        await within(() => reports >= wanted, PROBE_MS);
      }
    }
  } finally {
    subscription.close();
  }
}

const recorder = () => {
  const heard: string[] = [];
  return { heard, listener: (path: string) => heard.push(path) };
};

/**
 * The unconditional first report, out of the way: a test then hears only what it changes. It arrives in
 * the same look as the probe's first report, since both name a path in the one directory.
 */
async function primed(hub: FileEventHub, directory: string, heard: string[]): Promise<void> {
  await armed(hub, directory);
  heard.length = 0;
}

export function describeRealFileEvents(name: string, source: () => FileEventSource): void {
  describe(`FileEventHub over ${name}, on the real file system`, () => {
    it('should report an append to a JSONL file', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, 'session.jsonl');
      await writeFile(file, '{"n":1}\n');
      const { heard, listener } = recorder();
      const hub = hubOver(source());
      const subscription = hub.subscribe(file, listener);
      await primed(hub, directory, heard);

      // Act
      await appendFile(file, '{"n":2}\n');

      // Assert
      await until(() => heard.length > 0, 'the append');
      should(heard).deepEqual([file]);
      should(subscription.live()).be.true();
    });

    it('should report an atomic save, whose events name only the temporary file', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, 'state.json');
      await writeFile(file, '{"v":1}');
      const { heard, listener } = recorder();
      const hub = hubOver(source());
      hub.subscribe(file, listener);
      await primed(hub, directory, heard);

      // Act
      await writeFile(join(directory, 'state.json.tmp-1'), '{"v":2}');
      await rename(join(directory, 'state.json.tmp-1'), file);

      // Assert
      await until(() => heard.length > 0, 'the atomic save');
      should(heard).deepEqual([file]);
    });

    it('should report every one of many files changed at once in one directory', async () => {
      // Arrange
      const directory = await workspace();
      const files = Array.from({ length: 40 }, (_, index) => join(directory, `t-${String(index)}.jsonl`));
      await Promise.all(files.map(async file => await writeFile(file, 'a\n')));
      const heard = new Set<string>();
      const hub = hubOver(source());
      for (const file of files) hub.subscribe(file, path => heard.add(path));
      await armed(hub, directory);
      heard.clear();

      // Act: a burst a platform watcher may collapse into a handful of events.
      for (const file of files) await appendFile(file, 'b\n');

      // Assert
      await until(() => heard.size === files.length, 'every file');
    });

    it('should follow its directory through a delete and a recreate', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, 'session.jsonl');
      await writeFile(file, 'a\n');
      const { heard, listener } = recorder();
      const hub = hubOver(source());
      const subscription = hub.subscribe(file, listener);
      await primed(hub, directory, heard);

      // Act: recreated with the file already in it, in one step the hub cannot see half of. What reports it
      // is the look the hub takes at once on re-opening the watch — written after that look, the file would
      // be heard only by the new watch, and Bun's watch off macOS, opened again on a recreated path, hears
      // nothing: it reuses the deleted directory's descriptor, which it caches by path.
      await rm(directory, { recursive: true });
      await until(() => !subscription.live(), 'the directory to be noticed gone');
      heard.length = 0;
      mkdirSync(directory);
      writeFileSync(file, 'recreated\n');

      // Assert
      await until(() => subscription.live(), 'the directory to be watched again');
      await until(() => heard.length > 0, 'the file in the recreated directory');
      should(heard[0]).equal(file);
    });

    it('should wait for a directory that does not exist yet, and report the file once it appears', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, 'a', 'b', 'rollout.jsonl');
      const { heard, listener } = recorder();
      const hub = hubOver(source());
      const subscription = hub.subscribe(file, listener);
      const liveBefore = subscription.live();
      // The one directory that exists is what hears `a` appear.
      await armed(hub, directory);

      // Act
      await mkdir(join(directory, 'a', 'b'), { recursive: true });
      await until(() => subscription.live(), 'the new directories to be watched');
      await writeFile(file, 'hello\n');

      // Assert
      await until(() => heard.includes(file), 'the new file');
      should(liveBefore).be.false();
    });

    it('should report a change to a file whose name starts with a dot', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, '.hidden.json');
      await writeFile(file, '1');
      const { heard, listener } = recorder();
      const hub = hubOver(source());
      hub.subscribe(file, listener);
      await primed(hub, directory, heard);

      // Act
      await writeFile(file, '22');

      // Assert: by event where the source reports it, by poll where it does not.
      await until(() => heard.length > 0, 'the change');
    });
  });
}
