// Real-disk proof that the FINAL missing-tail recheck of stateHomeHolding fails CLOSED (audit C fix round 3): once the
// walk found a missing tail, the last `realpath` of the raw request may only be an ENOENT that the walk's own trail
// still vouches for. Any other errno, or an ENOENT that the disk now routes somewhere else, is doubt and answers the
// home's name. Mutations are real symlink/chmod/write calls scheduled at the syscall boundary where the walk re-looks
// at the missing entry; only the unknown-errno case injects an error code, because no disk produces one on demand.
// Temp dirs only; permissions are restored in a finally.
import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs, type HostFs } from '../../../host/adapters/node-fs.ts';
import { stateHomeHolding } from '../../../host/paths.ts';

const options = { files: [], recheckMs: 0 };

type Change = 'loop' | 'dangling-in-home' | 'unreadable' | 'not-a-directory' | 'unknown-errno' | 'none';

interface Outcome {
  readonly answer: string | undefined;
  readonly home: string;
  readonly requested: string;
  readonly changed: boolean;
  readonly rawResolves: number;
  readonly finalError: string | undefined;
  readonly fresh: string | undefined;
}

/**
 * The missing entry `work/later` is absent at the walk's look and at the trail's re-look; the change is published right
 * after that second look, so the final `realpath` of the raw request is the first thing to observe it.
 */
async function race(change: Change): Promise<Outcome> {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-final-recheck-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const requested = `${work}/later/leaf`;
  const disk = nodeFs(() => 'final-recheck-fixture');
  let looks = 0;
  let changed = false;
  let rawResolves = 0;
  let finalError: string | undefined;
  try {
    await mkdir(`${home}/state/reviewer`, { recursive: true });
    await mkdir(work);
    // A link IN the home makes the loop an in-home intermediate hop too.
    await symlink(`${work}/later`, `${home}/state/reviewer/out`);
    const racing: HostFs = {
      ...disk,
      identity: async path => {
        const seen = await disk.identity(path);
        if (path === `${work}/later` && ++looks === 2) {
          if (change === 'loop') await symlink(`${home}/state/reviewer/out`, `${work}/later`);
          else if (change === 'dangling-in-home') await symlink(`${home}/state/missing`, `${work}/later`);
          else if (change === 'unreadable') await chmod(work, 0o000);
          else if (change === 'not-a-directory') await writeFile(`${work}/later`, 'a file now');
          changed = change !== 'none' && change !== 'unknown-errno';
        }
        return seen;
      },
      realpath: async path => {
        if (path === requested) rawResolves += 1;
        try {
          if (change === 'unknown-errno' && path === requested && rawResolves === 2) {
            changed = true;
            throw Object.assign(new Error('a failure the kernel has no name for here'), { code: 'EWEIRD' });
          }
          return await disk.realpath(path);
        } catch (error) {
          if (path === requested && rawResolves === 2) finalError = (error as { code?: string }).code;
          throw error;
        }
      },
    };
    const answer = await stateHomeHolding(racing, home, options, requested);
    // Restore permissions before the assertions and the fresh check.
    await chmod(work, 0o700);
    const fresh = await stateHomeHolding(disk, home, options, requested);
    return { answer, home, requested, changed, rawResolves, finalError, fresh };
  } finally {
    await chmod(work, 0o700).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
}

test('control: a genuinely absent tail outside the home stays quiet (undefined), after a real final recheck', async () => {
  const seen = await race('none');
  expect(seen.rawResolves).toBe(2); // the first settling and the final recheck both ran
  expect(seen.finalError).toBe('ENOENT');
  expect(seen.answer).toBeUndefined();
  expect(seen.fresh).toBeUndefined();
});

test('an in-home link loop that appears before the final recheck (ELOOP) is held', async () => {
  const seen = await race('loop');
  expect(seen.changed).toBe(true);
  expect(seen.rawResolves).toBe(2);
  expect(seen.finalError).toBe('ELOOP');
  expect(seen.fresh).toBe(seen.home);
  expect(seen.answer).toBe(seen.home);
});

test('a dangling link into the home that appears before the final recheck (ENOENT through the link) is held', async () => {
  const seen = await race('dangling-in-home');
  expect(seen.changed).toBe(true);
  expect(seen.rawResolves).toBe(2);
  expect(seen.finalError).toBe('ENOENT');
  expect(seen.fresh).toBe(seen.home);
  expect(seen.answer).toBe(seen.home);
});

test('a work directory that turns unreadable before the final recheck (EACCES) is held', async () => {
  const seen = await race('unreadable');
  expect(seen.changed).toBe(true);
  expect(seen.rawResolves).toBe(2);
  // Running as root nothing is unreadable: then there is no error to hold, and the quiet answer is the true one.
  if (seen.finalError === undefined) return;
  expect(seen.finalError).toBe('EACCES');
  expect(seen.answer).toBe(seen.home);
});

test('a missing entry that becomes a regular file before the final recheck (ENOTDIR) is held', async () => {
  const seen = await race('not-a-directory');
  expect(seen.changed).toBe(true);
  expect(seen.rawResolves).toBe(2);
  expect(seen.finalError).toBe('ENOTDIR');
  expect(seen.answer).toBe(seen.home);
});

test('a final recheck that fails with an errno nobody named is doubt, so it is held', async () => {
  const seen = await race('unknown-errno');
  expect(seen.changed).toBe(true);
  expect(seen.rawResolves).toBe(2);
  expect(seen.finalError).toBe('EWEIRD');
  expect(seen.answer).toBe(seen.home);
});
