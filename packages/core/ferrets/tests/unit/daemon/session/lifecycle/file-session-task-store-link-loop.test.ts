import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import should from 'should';
import { FileSessionTaskStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-task-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const SESSION = parseSessionId('20260806-loop');
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

// No guarantees row covers this rule (docs/rebuild/guarantees.tsv names none): the kernel root refuses it.
describe('FileSessionTaskStore over a turn document that is a link pointing at itself (no guarantees row)', () => {
  it('should refuse with ELOOP on the internal sessions root, publish nothing, and never read it as "absent"', async () => {
    // Arrange: on the internal `sessions` root the kernel's base-anchored check meets the link first, so the platform's
    // own ELOOP is the refusal (an owner's root answers `fenced` at its hop bound instead; that is the kernel's to pin).
    const home = await mkdtemp(join(tmpdir(), 'fy-task-loop-'));
    homes.add(home);
    const { root } = await diskSessionsRoot(home, SESSION);
    const store = new FileSessionTaskStore(root, SESSION);
    const file = store.file(SESSION);
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await symlink(file, file);

    // Act
    const failure = await store.writeAssignedTask(SESSION, 'the task\n').then(
      () => undefined,
      (error: unknown) => error as { name?: string; code?: string; refusal?: string },
    );

    // Assert: exactly ELOOP, and the link is still the link (the task was not published through or over it)
    should(failure).not.be.undefined();
    should(failure?.code).equal('ELOOP');
    should(failure?.refusal).be.undefined();
    should((await lstat(file)).isSymbolicLink()).equal(true);
    should(await readlink(file)).equal(file);
  });
});
