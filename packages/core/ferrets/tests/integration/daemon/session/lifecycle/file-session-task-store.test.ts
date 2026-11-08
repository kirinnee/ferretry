import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskRoot } from '@ferretry/kernel/testing';
import should from 'should';
import { FileSessionTaskStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-task-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The assigned-task document, when what stands at its path is not a readable earlier copy of it.
 *
 * An exact replay is proved against the published file before anything is replaced, so the proof has
 * to tell "nothing there" from "something there that cannot be read". Both shapes below are real
 * directory entries, because the distinction is the platform's and a stand-in would only restate it.
 */

const SESSION = parseSessionId('20260806-task');
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function subject(): Promise<{ readonly store: FileSessionTaskStore; readonly file: string }> {
  const home = await mkdtemp(join(tmpdir(), 'fy-task-store-'));
  homes.add(home);
  const { root, folder } = await diskRoot(home);
  const store = new FileSessionTaskStore(root, () => join(folder, SESSION));
  const file = store.file(SESSION);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  return { store, file };
}

async function rejection(promise: Promise<unknown>): Promise<NodeJS.ErrnoException & { refusal?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error('expected the store to refuse, but it resolved');
}

describe('FileSessionTaskStore replay proof', () => {
  it('should refuse a path that cannot be opened for a reason other than being absent', async () => {
    // Arrange: a link that points at itself — the kernel's fenced read never follows it, and it is not "no file".
    const { store, file } = await subject();
    await symlink(file, file);

    // Act
    const failure = await rejection(store.writeAssignedTask(SESSION, 'the task\n'));

    // Assert: treating it as absent would publish over something nobody could read. The kernel root refuses the
    // endless link as `fenced` (its hop bound), a RootError rather than the platform's ELOOP.
    should(failure.name).equal('RootError');
    should(failure.refusal).equal('fenced');
  });

  it('should refuse a path that opens but cannot be read, and release what it opened', async () => {
    // Arrange: a directory opens read-only but cannot be read as a document.
    const { store, file } = await subject();
    await mkdir(file);

    // Act
    const failure = await rejection(store.writeAssignedTask(SESSION, 'the task\n'));

    // Assert: the kernel's root refuses it as "not a file" (a directory is not a document).
    should(failure.name).equal('RootError');
    should((failure as unknown as { refusal: string }).refusal).equal('not_a_file');
  });

  it('should replace an earlier, different document at the same path', async () => {
    // Arrange
    const { store, file } = await subject();
    await store.writeAssignedTask(SESSION, 'first\n');

    // Act
    await store.writeAssignedTask(SESSION, 'second\n');

    // Assert
    should(await readFile(file, 'utf8')).equal('second\n');
  });
});
