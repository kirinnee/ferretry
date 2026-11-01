import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  classifyStreamLink,
  HarnessProcessProvenance,
  ProcfsProcessTree,
  PsProcessTree,
  processTreeFor,
  SigtermProcessSignal,
} from '../../../../src/adapters/session/processes/index.ts';
import type { ProcessDetailRow } from '../../../../src/lib/session/processes/ports.ts';
import { waitFor, waitForValue } from '../../support/wait-for.ts';

/**
 * THE LINUX PROCESS-TREE READER, over real processes. The test process is the root of the walk, so only
 * children this file spawns are in play. Skipped off Linux: there is no procfs to read.
 */

const linux = process.platform === 'linux';

let directory: string;
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const loose = new Set<number>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-process-tree-'));
});

afterEach(async () => {
  for (const pid of loose)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  loose.clear();
  for (const child of spawned.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  await rm(directory, { recursive: true, force: true });
});

/** Polls the walk until `wanted` finds its row, so a child still being exec'd is waited for, not guessed at. */
async function waitForRow(
  tree: ProcfsProcessTree,
  wanted: (rows: readonly ProcessDetailRow[]) => ProcessDetailRow | undefined,
): Promise<readonly ProcessDetailRow[]> {
  return await waitForValue(async () => {
    const read = await tree.tree(process.pid);
    return read.kind === 'read' && wanted(read.rows) !== undefined ? read.rows : undefined;
  }, 'the spawned process to appear in the tree');
}

/**
 * The kernel's own state letter for `pid`, read straight from `/proc/<pid>/stat` — the oracle the reader is
 * checked against, so the test never asks the reader to vouch for itself.
 */
async function kernelState(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  return stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
}

/** Stops `pid` and waits until the kernel shows it stopped: a state that, unlike running or sleeping, holds still. */
async function stopped(pid: number): Promise<void> {
  process.kill(pid, 'SIGSTOP');
  await waitFor(async () => (await kernelState(pid)) === 'T', `process ${String(pid)} to be stopped`);
}

describe('ProcfsProcessTree', () => {
  it.skipIf(!linux)(
    'should list a shell and its child with their state, start, parentage and where output goes',
    async () => {
      // Arrange — the shell's stdout is the carrier Bun gives it (a socket); the child's is a file. The trailing `:` keeps
      // the shell from exec'ing the child away.
      const output = join(directory, 'sleeper.out');
      const shell = Bun.spawn(['sh', '-c', `sleep 30 > '${output}'; :`], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      spawned.push(shell);
      const tree = new ProcfsProcessTree();
      const isSleeper = (rows: readonly ProcessDetailRow[]) =>
        rows.find(row => row.ppid === shell.pid && row.argv === 'sleep 30');

      // A shell that has just forked may still be on a CPU (`R`) or already waiting on its child (`S`) — which one is
      // the scheduler's choice, not the reader's (a one-CPU runner shows `R` about one time in five). Stopping it
      // pins the state the kernel reports, so the reader's answer can be checked exactly.
      await waitForRow(tree, isSleeper);
      await stopped(shell.pid);

      // Act
      const rows = await waitForRow(tree, isSleeper);
      const shellRow = rows.find(row => row.pid === shell.pid);
      const sleeper = isSleeper(rows);

      // Assert
      should(shellRow).not.be.undefined();
      should(sleeper).not.be.undefined();
      if (shellRow === undefined || sleeper === undefined) return;
      should(shellRow.ppid).equal(process.pid);
      should(shellRow.argv).equal(`sh -c sleep 30 > '${output}'; :`);
      should(shellRow.state).equal('T');
      should(shellRow.stdout).deepEqual({ kind: 'socket' });
      should(shellRow.stderr).deepEqual({ kind: 'null' });
      should(sleeper.stdout).deepEqual({ kind: 'file', path: output });
      should(sleeper.stderr).deepEqual({ kind: 'null' });
      should(rows.indexOf(shellRow)).be.below(rows.indexOf(sleeper));
      should(Math.abs(Date.now() - sleeper.startedAtMs)).be.below(120_000);
      should(sleeper.rssBytes).be.above(0);
      should(sleeper.cpuSeconds).be.aboveOrEqual(0);
      loose.add(sleeper.pid);
    },
    15_000,
  );

  it.skipIf(!linux)(
    'should name a process whose output feeds a pipe as a pipe, not a file',
    async () => {
      // Arrange — `sleep` writes into `cat`, so its stdout is an anonymous pipe nobody here may open.
      const shell = Bun.spawn(['sh', '-c', 'sleep 30 | cat > /dev/null; :'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      spawned.push(shell);
      const tree = new ProcfsProcessTree();
      const isSleeper = (rows: readonly ProcessDetailRow[]) =>
        rows.find(row => row.ppid === shell.pid && row.argv === 'sleep 30');

      // Act
      const rows = await waitForRow(tree, isSleeper);
      const sleeper = isSleeper(rows);

      // Assert
      should(sleeper?.stdout).deepEqual({ kind: 'pipe' });
      for (const row of rows) if (row.ppid === shell.pid) loose.add(row.pid);
    },
    15_000,
  );

  it.skipIf(!linux)('should report a start that startOf reads again unchanged, and none once it exited', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    spawned.push(child);
    const tree = new ProcfsProcessTree();
    const rows = await waitForRow(tree, found => found.find(row => row.pid === child.pid));
    const row = rows.find(candidate => candidate.pid === child.pid);

    // Act
    const before = await tree.startOf(child.pid);
    child.kill('SIGKILL');
    await child.exited;
    const after = await tree.startOf(child.pid);

    // Assert
    should(row?.start).be.a.Number();
    should(before).equal(row?.start);
    should(after).be.undefined();
    should(row?.stdout).deepEqual({ kind: 'null' });
  });

  it.skipIf(!linux)('should walk only the subtree of the root it is given', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    spawned.push(child);
    const tree = new ProcfsProcessTree();
    await waitForRow(tree, found => found.find(row => row.pid === child.pid));

    // Act
    const below = await tree.tree(child.pid);

    // Assert — `sleep` has no children, and the root itself is never listed.
    should(below).deepEqual({ kind: 'read', rows: [] });
  });

  it.skipIf(!linux)('should say the pane cannot be read for a pid that does not exist', async () => {
    // Act
    const read = await new ProcfsProcessTree().tree(2_147_483_646);

    // Assert
    should(read.kind).equal('unavailable');
  });

  it('should leave out a process that exited between being listed and being read, and keep the rest', async () => {
    // Arrange — a procfs under a temp directory: pid 200 is listed but its command line is already gone.
    const proc = join(directory, 'proc');
    const statLine = (pid: number, comm: string) =>
      `${String(pid)} (${comm}) S 100 ${Array.from({ length: 50 }, (_, index) => String(index + 1)).join(' ')}`;
    await mkdir(join(proc, '100', 'task', '100'), { recursive: true });
    await writeFile(join(proc, 'stat'), 'btime 1000\n');
    await writeFile(join(proc, '100', 'task', '100', 'children'), '200 300 ');
    for (const [pid, comm] of [
      [200, 'vanished'],
      [300, 'stayed'],
    ] as const) {
      await mkdir(join(proc, String(pid)), { recursive: true });
      await writeFile(join(proc, String(pid), 'stat'), statLine(pid, comm));
    }
    await writeFile(join(proc, '300', 'cmdline'), 'stayed\0--flag\0');

    // Act
    const read = await new ProcfsProcessTree(proc).tree(100);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(read.rows.map(row => [row.pid, row.argv])).deepEqual([[300, 'stayed --flag']]);
  });
});

describe('classifyStreamLink', () => {
  const regular = async () => true;
  const notRegular = async () => false;

  it('should name an absolute path that is not a regular file, and any other link as it reads', async () => {
    // Act
    const device = await classifyStreamLink('/dev/zero', notRegular);
    const anonymous = await classifyStreamLink('anon_inode:[eventfd]', regular);
    const file = await classifyStreamLink('/var/log/out.log', regular);

    // Assert
    should(device).deepEqual({ kind: 'other', description: 'not a regular file' });
    should(anonymous).deepEqual({ kind: 'other', description: 'anon_inode:[eventfd]' });
    should(file).deepEqual({ kind: 'file', path: '/var/log/out.log' });
  });
});

describe('SigtermProcessSignal', () => {
  it.skipIf(!linux)('should terminate a live process, and answer false once it is gone', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    spawned.push(child);
    const signal = new SigtermProcessSignal();

    // Act
    const sent = await signal.terminate(child.pid);
    await child.exited;
    const again = await signal.terminate(child.pid);

    // Assert
    should(sent).be.true();
    should(child.signalCode).equal('SIGTERM');
    should(again).be.false();
  });

  it('should not swallow a failure that is not "already gone"', async () => {
    // Act + Assert — a pid that is no pid at all is a defect in the caller, not an exited process.
    await should(new SigtermProcessSignal().terminate(Number.NaN)).be.rejected();
  });
});

describe('PsProcessTree', () => {
  const ps = Bun.which('ps');

  it('should refuse a ps executable that is not an absolute path', () => {
    // Act
    const construct = () => new PsProcessTree('ps');

    // Assert
    should(construct).throw(/absolute path/u);
  });

  it.skipIf(!linux || ps === null)(
    'should list a spawned child from one ps table, with no descriptors and no listener information',
    async () => {
      // Arrange
      const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      spawned.push(child);
      const tree = new PsProcessTree(ps as string);

      // Act
      const read = await tree.tree(process.pid);
      const listening = await tree.listening();

      // Assert
      should(read.kind).equal('read');
      if (read.kind !== 'read') return;
      const row = read.rows.find(candidate => candidate.pid === child.pid);
      should(row).not.be.undefined();
      should(row?.ppid).equal(process.pid);
      should(row?.argv).equal('sleep 30');
      should(row?.stdout).be.undefined();
      should(row?.stderr).be.undefined();
      should(row?.rssBytes).be.above(0);
      should(Math.abs(Date.now() - (row?.startedAtMs ?? 0))).be.below(120_000);
      should(listening).be.undefined();
    },
    15_000,
  );
});

describe('the process-tree adapters, the rest of their surface', () => {
  const ps = Bun.which('ps');

  it.skipIf(!linux)('should find a process holding a listening TCP socket, and none for one without', async () => {
    // Arrange
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const idle = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    spawned.push(idle);
    const tree = new ProcfsProcessTree();

    try {
      // A child between fork and exec still holds a copy of this process's descriptors — the listener
      // among them — because close-on-exec only acts at exec, and on a loaded runner this question can
      // be reached before the child is. Waiting for the argv to read `sleep 30` waits for the exec
      // itself, so the reader is asked about the child that exists, not the one still being spawned.
      await waitForRow(tree, rows => rows.find(row => row.pid === idle.pid && row.argv === 'sleep 30'));

      // Act
      const listening = await tree.listening([process.pid, idle.pid]);

      // Assert
      should([...(listening ?? [])]).deepEqual([process.pid]);
    } finally {
      server.stop(true);
    }
  });

  it.skipIf(!linux || ps === null)('should read a start through ps, and none once the process is gone', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    spawned.push(child);
    const tree = new PsProcessTree(ps as string);

    // Act
    const live = await tree.startOf(child.pid);
    child.kill('SIGKILL');
    await child.exited;
    const gone = await tree.startOf(child.pid);

    // Assert
    should(live).be.a.Number().and.be.above(0);
    should(gone).be.undefined();
  });

  it('should say the table could not be read when ps cannot run', async () => {
    // Arrange
    const tree = new PsProcessTree(join(directory, 'no-such-ps'));

    // Act
    const read = await tree.tree(process.pid);

    // Assert
    should(read).deepEqual({ kind: 'unavailable', reason: 'The process table could not be read.' });
  });

  it('should pick procfs on Linux and ps everywhere else', () => {
    // Act
    const onLinux = processTreeFor('linux');
    const onMac = processTreeFor('darwin');

    // Assert
    should(onLinux).be.instanceOf(ProcfsProcessTree);
    should(onMac).be.instanceOf(PsProcessTree);
  });
});

describe('HarnessProcessProvenance', () => {
  it.skipIf(!linux)(
    "should read the project's servers from the directory the pane runs in and recognise the tools server",
    async () => {
      // Arrange
      const pane = Bun.spawn(['sleep', '30'], { cwd: directory, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      spawned.push(pane);
      const asked: string[] = [];
      const provenance = new HarnessProcessProvenance('fy', {
        read: async (path: string) => {
          asked.push(path);
          return [];
        },
      });
      const rows: readonly ProcessDetailRow[] = [
        { pid: 9_001, ppid: pane.pid, start: 1, startedAtMs: 0, argv: 'fy mcp serve', state: 'S' },
        { pid: 9_002, ppid: pane.pid, start: 1, startedAtMs: 0, argv: 'zsh -c bun test', state: 'S' },
      ];

      // Act
      const known = await provenance.identify(rows, pane.pid);

      // Assert
      should(asked).deepEqual([await realpath(directory)]);
      should(known.has(9_001)).be.true();
      should(known.has(9_002)).be.false();
    },
  );

  it('should ask for no configured servers where there is no procfs to find the pane directory', async () => {
    // Arrange
    const asked: string[] = [];
    const provenance = new HarnessProcessProvenance(
      'fy',
      {
        read: async (path: string) => {
          asked.push(path);
          return [];
        },
      },
      null,
    );

    // Act
    await provenance.identify([], 4_242);

    // Assert
    should(asked).deepEqual([]);
  });
});
