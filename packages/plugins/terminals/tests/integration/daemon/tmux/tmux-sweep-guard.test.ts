/**
 * The run's tmux sweep (`scripts/test/tmux-sweep.ts`) never reaches a server it was not given, however
 * it is called.
 *
 * Suites are run from inside live agents, and the server every agent on the machine runs under is one
 * `kill-server` — or one SIGTERM from a sweep — away. So the sweep refuses, before a single signal, any
 * root that is not strictly inside a temporary directory or that holds a protected path, and skips a
 * server whose socket resolves into one however it was reached. Every server here is a throwaway on a
 * socket under this test's own temporary directory; the sweep runs as the process callers run.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import { PROTECTED_PATHS_VARIABLE } from '../../support/ambient-session.ts';

const SWEEP = resolve(import.meta.dir, '../../../../../scripts/test/tmux-sweep.ts');
const TMUX = Bun.which('tmux');
const roots: string[] = [];
const sockets: string[] = [];

afterEach(async () => {
  if (TMUX !== null) for (const socket of sockets.splice(0)) Bun.spawnSync([TMUX, '-S', socket, 'kill-server']);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function tmux(): string {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  return TMUX;
}

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `fy-sweep-guard-${label}-`));
  roots.push(root);
  return root;
}

/** A throwaway tmux server with one sleeping pane on `socket`. */
function serverOn(socket: string): void {
  sockets.push(socket);
  const started = Bun.spawnSync([
    tmux(),
    '-f',
    '/dev/null',
    '-S',
    socket,
    'new-session',
    '-d',
    '-s',
    'probe',
    'sleep 600',
  ]);
  if (started.exitCode !== 0) throw new Error(`tmux would not start: ${started.stderr.toString()}`);
}

function alive(socket: string): boolean {
  return Bun.spawnSync([tmux(), '-S', socket, 'has-session', '-t', 'probe'], { stderr: 'ignore' }).exitCode === 0;
}

function sweep(protectedPaths: readonly string[], ...args: string[]): { code: number; said: string } {
  const ran = Bun.spawnSync([process.execPath, SWEEP, ...args], {
    env: { ...process.env, [PROTECTED_PATHS_VARIABLE]: protectedPaths.join(':') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: ran.exitCode ?? -1, said: ran.stderr.toString() };
}

describe('the run’s tmux sweep', () => {
  it('should refuse a root outside every temporary directory and kill nothing', () => {
    // Act
    const { code, said } = sweep([], resolve(import.meta.dir));

    // Assert
    should(code).equal(2);
    should(said).match(/refusing to sweep: .* is not inside a temporary directory — nothing was killed/u);
  });

  it('should refuse a root that holds a protected home, and leave the server in it running', async () => {
    // Arrange
    const root = await scratch('holds');
    const home = join(root, 'home');
    await mkdir(home);
    const socket = join(home, 'tmux.sock');
    serverOn(socket);

    // Act
    const { code, said } = sweep([home], root);

    // Assert
    should(code).equal(2);
    should(said).match(/is, holds or lies inside/u);
    should(alive(socket)).be.true();
  });

  it('should never sweep a server whose socket resolves into a protected home, even through a link', async () => {
    // Arrange — the root itself is disposable; only the canonical socket gives the protected home away.
    const root = await scratch('link');
    const home = await scratch('home');
    await symlink(home, join(root, 'link'));
    const socket = join(root, 'link', 'tmux.sock');
    serverOn(socket);

    // Act
    const { code, said } = sweep([home], root);

    // Assert
    should(code).equal(0);
    should(said).not.match(/killed leaked tmux server/u);
    should(alive(socket)).be.true();
  });

  it('should still sweep a leaked server under a disposable root', async () => {
    // Arrange
    const root = await scratch('leak');
    const socket = join(root, 'tmux.sock');
    serverOn(socket);

    // Act
    const { code, said } = sweep([], '--fail-on-leak', root);

    // Assert
    should(code).equal(1);
    should(said).containEql(`killed leaked tmux server`);
    should(said).containEql(socket);
    should(alive(socket)).be.false();
  });
});
