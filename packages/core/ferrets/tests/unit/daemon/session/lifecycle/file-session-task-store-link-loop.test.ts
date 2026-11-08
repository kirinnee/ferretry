import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskRoot } from '@ferretry/kernel/testing';
import should from 'should';
import { FileSessionTaskStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-task-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const SESSION = parseSessionId('20260806-loop');
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

// No guarantees row covers this rule (docs/rebuild/guarantees.tsv names none): the kernel root, not an errno, refuses it.
describe('FileSessionTaskStore over a turn document that is a link pointing at itself (no guarantees row)', () => {
  it('should refuse with the kernel root’s own refusal word, never an errno and never as "absent"', async () => {
    // Arrange: the fenced read walks the link's hops and gives up at the kernel's bound, so the refusal is
    // `fenced` — a RootError — and not the ELOOP the platform's realpath would have raised.
    const home = await mkdtemp(join(tmpdir(), 'fy-task-loop-'));
    homes.add(home);
    const { root, folder } = await diskRoot(home);
    const store = new FileSessionTaskStore(root, () => join(folder, SESSION));
    const file = store.file(SESSION);
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await symlink(file, file);

    // Act
    const failure = await store.writeAssignedTask(SESSION, 'the task\n').then(
      () => undefined,
      (error: unknown) => error as { name?: string; code?: string; refusal?: string },
    );

    // Assert
    should(failure).not.be.undefined();
    should(failure?.name).equal('RootError');
    should(failure?.refusal).equal('fenced');
    should(failure?.code).be.undefined();
  });
});
