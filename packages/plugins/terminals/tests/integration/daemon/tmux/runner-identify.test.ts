import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { paneProcessHost } from '../../../../daemon/adapters/tmux/pane-process-host.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * `TmuxRunner.identify` and `signalDescendant` over a REAL tmux server and REAL processes, on a private socket in a temp
 * directory: the owner's own tmux server and default socket are never touched, and only this test's server is killed.
 * The pane runs two background `sleep`s under its shell. Linux only: the proof reads procfs.
 */
const linux = process.platform === 'linux';
const TMUX = Bun.which('tmux');
const FERRET = ferretId('idn');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Whether `pid` still runs (a zombie waiting to be reaped counts as ended: its state is `Z`). */
async function running(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  return stat !== undefined && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}

/** The kernel's own start for `pid` (field 22 of `/proc/<pid>/stat`): the oracle the runner is checked against. */
async function kernelStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat
    .slice(stat.lastIndexOf(')') + 2)
    .split(' ')
    .at(19) as string;
}

async function pane(signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void) {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-identify-'));
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  const handle = Object.freeze({ names: [] }) as unknown as ChildEnvironment;
  const spawn = bunSpawn(process.env as Record<string, string>, () => ({
    open: env => (env === handle ? { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } : undefined),
    searchPathOf: () => undefined,
  }));
  const runner = new TmuxRunner({
    tmux,
    spawn,
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    processes: signal === undefined ? paneProcessHost(spawn) : { ...paneProcessHost(spawn), signal },
  });
  const started = await runner.start({
    ferret: FERRET,
    command: ['sh', '-c', 'sleep 300 & sleep 301 & wait'],
    cwd: fenced(root),
    env: handle,
  });
  if (!started.ok) throw new Error(`the pane did not start: ${JSON.stringify(started.error)}`);
  return {
    runner,
    tmux,
    handle: started.value.handle,
    rootPid: started.value.pid as number,
    host: paneProcessHost(spawn),
  };
}

async function sleepers(host: ReturnType<typeof paneProcessHost>, rootPid: number) {
  let found: { readonly pid: number; readonly start: string; readonly argv: string }[] = [];
  await waitFor(async () => {
    const read = await host.tree(rootPid);
    found = read.kind === 'read' ? read.rows.map(r => ({ pid: r.pid, start: String(r.start), argv: r.argv })) : [];
    return found.filter(row => row.argv.startsWith('sleep 30')).length === 2;
  }, 'the pane to run its two sleeps');
  return found;
}

describe('TmuxRunner.identify and signalDescendant over a real tmux server', () => {
  it.skipIf(!linux)(
    'should treat a process that exited (ESRCH) or is not ours (EPERM) as not delivered, and rethrow anything else',
    async () => {
      // Arrange — a real pane and real proof; only the final kill is made to fail, with the errno the kernel would give
      let code = 'ESRCH';
      const { runner, handle, host, rootPid } = await pane(() => {
        throw Object.assign(new Error(code), { code });
      });
      const target = (await sleepers(host, rootPid)).find(row => row.argv.startsWith('sleep 30'));
      if (target === undefined) throw new Error('a sleep was expected');

      // Act + Assert
      for (code of ['ESRCH', 'EPERM'])
        should(await runner.signalDescendant(handle, target.pid, target.start, 'SIGTERM', FERRET)).equal(false);
      code = 'EINVAL';
      await runner.signalDescendant(handle, target.pid, target.start, 'SIGTERM', FERRET).then(
        () => {
          throw new Error('an unexpected errno must reject');
        },
        (error: unknown) => should((error as Error).message).equal('EINVAL'),
      );
      should(await running(target.pid)).equal(true);
    },
  );

  it.skipIf(!linux)(
    'should name the pane by handle, pid and the kernel start, and prove it gone after it ends',
    async () => {
      // Arrange
      const { runner, tmux, handle, rootPid } = await pane();

      // Act
      const identity = await runner.identify(handle);

      // Assert
      should(identity).deepEqual({ handle, pid: rootPid, processStart: await kernelStart(rootPid) });
      // The server exits with its last session; a read in that instant (`server exited unexpectedly`) proves nothing, so
      // it is never `'gone'`: the proof arrives once tmux says it has no server.
      await tmux.execute(['kill-session', '-t', 'fy-idn']);
      await waitFor(async () => (await runner.identify(handle)) === 'gone', 'tmux to prove the pane gone');
    },
  );

  it.skipIf(!linux)('should signal exactly one proved descendant and leave every other process alone', async () => {
    // Arrange
    const { runner, handle, host, rootPid } = await pane();
    const [first, second] = (await sleepers(host, rootPid)).filter(row => row.argv.startsWith('sleep 30'));
    if (first === undefined || second === undefined) throw new Error('two sleeps were expected');
    const outsider = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    cleanups.push(() => void outsider.kill('SIGKILL'));
    const outsiderStart = await kernelStart(outsider.pid);

    // Act + Assert — a process outside the pane, a wrong start, the root itself and the daemon are all refused
    should(await runner.signalDescendant(handle, outsider.pid, outsiderStart, 'SIGKILL', FERRET)).equal(false);
    should(await runner.signalDescendant(handle, first.pid, String(Number(first.start) + 1), 'SIGKILL', FERRET)).equal(
      false,
    );
    should(await runner.signalDescendant(handle, rootPid, await kernelStart(rootPid), 'SIGKILL', FERRET)).equal(false);
    should(await runner.signalDescendant(handle, process.pid, await kernelStart(process.pid), 'SIGKILL', FERRET)).equal(
      false,
    );
    should(await running(outsider.pid)).equal(true);
    should(await running(first.pid)).equal(true);
    should(await running(second.pid)).equal(true);

    // Act — the proved descendant gets the signal
    should(await runner.signalDescendant(handle, first.pid, first.start, 'SIGTERM', FERRET)).equal(true);

    // Assert — only that pid ended; its sibling, the pane and the outsider are untouched
    await waitFor(async () => !(await running(first.pid)), 'the signalled process to end');
    should(await running(second.pid)).equal(true);
    should(await running(rootPid)).equal(true);
    should(await running(outsider.pid)).equal(true);
    should(await runner.signalDescendant(handle, second.pid, second.start, 'SIGKILL', FERRET)).equal(true);
    await waitFor(async () => !(await running(second.pid)), 'the SIGKILLed process to end');
    // A pid that has ended is no descendant any more.
    should(await runner.signalDescendant(handle, first.pid, first.start, 'SIGTERM', FERRET)).equal(false);
  });
});
