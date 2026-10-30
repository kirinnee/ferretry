// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';

const FY_ENTRY = resolve(import.meta.dir, '../../../bin/fy.ts');

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function closedLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('the fixture server reported no port');
  return port;
}

describe('a daemon restart under a ferret that is mid-turn', () => {
  it('makes a person’s fy call wait only while a restart is vouched for', async () => {
    // Arrange — a state home with no restart marker, and nothing listening where `fy` looks.
    root = await mkdtemp(join(tmpdir(), 'fy-restart-rw-'));
    const port = await closedLoopbackPort();
    const child = Bun.spawn({
      cmd: [process.execPath, FY_ENTRY, 'ps', '--json'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        XDG_STATE_HOME: join(root, 'xdg-state'),
        XDG_CONFIG_HOME: join(root, 'config-home'),
        FY_HOME: join(root, 'state'),
        FY_URL: `http://127.0.0.1:${String(port)}`,
        NO_COLOR: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Act — no marker: a stopped daemon fails at once.
    const startedAt = Date.now();
    const code = await child.exited;
    const refusedAfterMs = Date.now() - startedAt;

    // Assert
    should(code).not.equal(0);
    should(refusedAfterMs).be.below(15_000);
  }, 120_000);
});
