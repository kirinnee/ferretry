/**
 * The link a Codex wrapper makes from the runtime home's `auth.json` to the sign-in file Logins keeps (B03), run for real in a
 * temp fixture: no Codex is launched, no real home is read, and every file here is a fake whose text is a marker.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signInLinkLines } from '../../../daemon/lib/wrappers.ts';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

/** A runtime home and a Logins store folder in a fresh temp world; `run` executes the wrapper's link lines in `sh`. */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'fy-wrapper-link-'));
  made.push(root);
  const home = join(root, 'fleet', 'homes', 'runtime');
  const store = join(root, 'state', 'logins', 'credentials', 'codex-work');
  await mkdir(home, { recursive: true });
  await mkdir(store, { recursive: true });
  const link = { path: join(home, 'auth.json'), target: join(store, 'auth.json') };
  const run = async (): Promise<{ readonly status: number; readonly stderr: string }> => {
    const child = Bun.spawn(['sh', '-c', signInLinkLines(link).join('\n')], { stdout: 'pipe', stderr: 'pipe' });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { status, stderr };
  };
  return { link, run, store };
}

describe('signInLinkLines — a Codex wrapper signs in through the file Logins names', () => {
  it('should link the home to the sign-in file, which a fresh sign-in then fills through the link', async () => {
    // Arrange
    const { link, run } = await world();

    // Act
    const outcome = await run();
    await writeFile(link.target, 'FAKE-SIGN-IN-MARKER');

    // Assert
    expect(outcome.status).toBe(0);
    expect(await readlink(link.path)).toBe(link.target);
    expect(await readFile(link.path, 'utf8')).toBe('FAKE-SIGN-IN-MARKER');
  });

  it('should leave a link that is already right, and move one that points elsewhere', async () => {
    // Arrange
    const { link, run, store } = await world();
    await symlink(join(store, 'stale.json'), link.path);

    // Act
    await run();
    const moved = await readlink(link.path);
    await run();

    // Assert
    expect(moved).toBe(link.target);
    expect(await readlink(link.path)).toBe(link.target);
  });

  it('should never replace a regular file somebody put there: it is theirs, and the launch goes on', async () => {
    // Arrange
    const { link, run } = await world();
    await writeFile(link.path, 'THEIRS');

    // Act
    const outcome = await run();

    // Assert
    expect(outcome.status).toBe(0);
    expect((await lstat(link.path)).isSymbolicLink()).toBe(false);
    expect(await readFile(link.path, 'utf8')).toBe('THEIRS');
  });

  it('should say so, and not stop, when the link cannot be made', async () => {
    // Arrange: the runtime home is gone, so there is nowhere to put the link.
    const { link, run } = await world();
    await rm(join(link.path, '..'), { recursive: true });

    // Act
    const outcome = await run();

    // Assert
    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toContain('could not link this runtime to its Codex sign-in');
  });
});
