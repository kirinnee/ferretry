/**
 * The hub over a real file-event source on the real file system: the scenarios every source must pass.
 * Each test works in a private directory INSIDE its temp root, so the parent the hub also watches holds
 * nothing but that directory (a shared temp directory holds sockets, which Bun's `fs.watch` dies on).
 */
import { afterEach, describe, it } from 'bun:test';
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

/** Wait until `done` holds, failing after a generous bound: real events arrive on the kernel's schedule. */
export async function until(done: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export function hubOver(source: FileEventSource): FileEventHub {
  const hub = new FileEventHub(source, unrefFileEventTimers, { settleMs: 10, pollMs: 50 });
  hubs.push(hub);
  return hub;
}

const recorder = () => {
  const heard: string[] = [];
  return { heard, listener: (path: string) => heard.push(path) };
};

/** The unconditional first report, out of the way: a test then hears only what it changes. */
async function primed(directory: string, heard: string[], count: number): Promise<void> {
  await writeFile(join(directory, 'prime'), 'x');
  await until(() => heard.length >= count, 'the first report');
  await Bun.sleep(30);
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
      const subscription = hubOver(source()).subscribe(file, listener);
      await primed(directory, heard, 1);

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
      hubOver(source()).subscribe(file, listener);
      await primed(directory, heard, 1);

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
      await writeFile(join(directory, 'prime'), 'x');
      await until(() => heard.size === files.length, 'the first report');
      await Bun.sleep(30);
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
      const subscription = hubOver(source()).subscribe(file, listener);
      await primed(directory, heard, 1);

      // Act
      await rm(directory, { recursive: true });
      await until(() => !subscription.live(), 'the directory to be noticed gone');
      await mkdir(directory);
      await until(() => subscription.live(), 'the directory to be watched again');
      heard.length = 0;
      await writeFile(file, 'recreated\n');

      // Assert
      await until(() => heard.length > 0, 'the file in the recreated directory');
      should(heard[0]).equal(file);
    });

    it('should wait for a directory that does not exist yet, and report the file once it appears', async () => {
      // Arrange
      const directory = await workspace();
      const file = join(directory, 'a', 'b', 'rollout.jsonl');
      const { heard, listener } = recorder();
      const subscription = hubOver(source()).subscribe(file, listener);
      const liveBefore = subscription.live();

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
      hubOver(source()).subscribe(file, listener);
      await primed(directory, heard, 1);

      // Act
      await writeFile(file, '22');

      // Assert: by event where the source reports it, by poll where it does not.
      await until(() => heard.length > 0, 'the change');
    });
  });
}
