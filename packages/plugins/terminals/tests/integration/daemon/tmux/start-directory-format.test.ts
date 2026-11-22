import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { sessionTarget } from '../../../../daemon/lib/tmux/address.ts';
import { newSessionArguments } from '../../../../daemon/lib/tmux/commands.ts';
import { scriptLine } from '../../../../daemon/lib/tmux/script.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { stopTmuxServer } from '../support/stop-tmux-server.ts';
import { waitForValue } from '../support/wait-for.ts';

/**
 * tmux expands formats in `-c <start-directory>`: a folder named `#(touch pwned)` ran that command inside the
 * server. Everything here runs on a PRIVATE socket in a temp folder; the daemon's own server is never touched.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function arrange(): Promise<{ tmux: BunTmuxProcess; root: string; hostile: string }> {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fy-cwdfmt-')));
  const hostile = join(root, '#(touch pwned)');
  await mkdir(hostile);
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
    await stopTmuxServer(TMUX, socket);
    await rm(root, { recursive: true, force: true });
  });
  return { tmux, root, hostile };
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** `#(touch pwned)` would drop `pwned` in the server's, the pane's or the test's folder: look in all of them. */
const anyPwned = async (root: string, hostile: string): Promise<boolean> =>
  (await Promise.all([join(root, 'pwned'), join(hostile, 'pwned'), join(process.cwd(), 'pwned')].map(exists))).some(
    Boolean,
  );

describe('a start directory named like a tmux format', () => {
  it('should open in that directory and run nothing (argv path)', async () => {
    // Arrange
    const { tmux, root, hostile } = await arrange();
    // Act
    const created = await tmux.execute([
      'start-server',
      ';',
      ...newSessionArguments({ session: 'probe', cwd: hostile, command: ['sleep', '60'] }),
    ]);
    // Assert
    should(created.code).equal(0, created.stderr);
    const where = await waitForValue(async () => {
      const r = await tmux.execute(['display-message', '-p', '-t', sessionTarget('probe'), '#{pane_current_path}']);
      return r.stdout.trim() === '' ? undefined : r.stdout.trim();
    }, 'the pane to report its directory');
    should(where).equal(hostile);
    should(await anyPwned(root, hostile)).be.false();
  });

  it('should open in that directory and run nothing (source-file script path)', async () => {
    // Arrange
    const { tmux, root, hostile } = await arrange();
    const script = scriptLine(newSessionArguments({ session: 'probe', cwd: hostile, command: ['sleep', '60'] }));
    // Act
    const socket = join(root, 's');
    const child = Bun.spawnSync([TMUX as string, '-S', socket, 'start-server', ';', 'source-file', '-'], {
      stdin: Buffer.from(script),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const created = { code: child.exitCode, stderr: child.stderr.toString() };
    // Assert
    should(created.code).equal(0, created.stderr);
    const where = await waitForValue(async () => {
      const r = await tmux.execute(['display-message', '-p', '-t', sessionTarget('probe'), '#{pane_current_path}']);
      return r.stdout.trim() === '' ? undefined : r.stdout.trim();
    }, 'the pane to report its directory');
    should(where).equal(hostile);
    should(await anyPwned(root, hostile)).be.false();
  });

  it('should store a title or name that looks like a format verbatim, never expanding it', async () => {
    // Arrange
    const { tmux, root, hostile } = await arrange();
    await tmux.execute([
      'start-server',
      ';',
      ...newSessionArguments({ session: 'probe', cwd: root, command: ['sleep', '60'] }),
    ]);
    const title = '#(touch pwned) #{pane_id}';
    // Act
    const set = await tmux.execute(['set-option', '-t', sessionTarget('probe'), '@fy_title', title]);
    const read = await tmux.execute(['show-options', '-v', '-t', sessionTarget('probe'), '@fy_title']);
    // Assert
    should(set.code).equal(0, set.stderr);
    should(read.stdout.trim()).equal(title);
    should(await anyPwned(root, hostile)).be.false();
  });
});
