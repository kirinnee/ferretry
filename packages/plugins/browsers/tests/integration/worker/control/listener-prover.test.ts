import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { ProcListenerProver } from '../../../../src/adapters/browser/control/listener-prover.ts';

/**
 * The prover reads a `/proc` the test stages in a temp directory — socket tables, `fd` links and `stat` lines —
 * so a squatter, a forked child and a host with no tables are all written down rather than started. One case
 * reads this host's real `/proc`, against a listener the test itself holds.
 */

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const LOOPBACK_V4 = '0100007F'; // 127.0.0.1

/** One `/proc/net/tcp` LISTEN row. */
function row(port: number, uid: number, inode: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${LOOPBACK_V4}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 ${String(inode)} 1 0000000000000000 100 0 0 10 0`;
}

const OWNER = 1_001;
const STRANGER = 1_002;
const PORT = 41_234;
/** The supervisor the daemon spawned (`timeout`), and the x11vnc it forked. */
const SUPERVISOR = 100;
const FORKED = 101;
/** Above any real pid_max, so it holds nothing and parents nothing. */
const NO_SUCH_PID = 2_147_483_647;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface StagedProcess {
  readonly pid: number;
  readonly ppid: number;
  /** What each fd links to: `socket:[N]`, a pipe, a file. */
  readonly fds?: readonly string[];
  /** The raw `stat` text, when the case is about a malformed one; `null` for a process gone mid-read. */
  readonly stat?: string | null;
  /** An fd entry that is not a link at all. */
  readonly plainFd?: boolean;
}

/** A fake `/proc`: `tables` is `undefined` for a host that publishes none. */
async function procRoot(tables: readonly string[] | undefined, processes: readonly StagedProcess[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-listener-prover-'));
  roots.push(root);
  if (tables !== undefined) {
    await mkdir(join(root, 'net'));
    await writeFile(join(root, 'net', 'tcp'), [HEADER, ...tables].join('\n'));
  }
  await mkdir(join(root, 'self'));
  for (const staged of processes) {
    const directory = join(root, String(staged.pid));
    await mkdir(join(directory, 'fd'), { recursive: true });
    if (staged.stat !== null) {
      await writeFile(
        join(directory, 'stat'),
        staged.stat ?? `${String(staged.pid)} (x11vnc (a) b) S ${String(staged.ppid)} 1 1 0 -1`,
      );
    }
    if (staged.plainFd === true) await writeFile(join(directory, 'fd', 'plain'), '');
    for (const [fd, target] of (staged.fds ?? []).entries()) await symlink(target, join(directory, 'fd', String(fd)));
  }
  return root;
}

describe('ProcListenerProver', () => {
  it('should prove a listener the spawned process holds itself', async () => {
    // Arrange
    const root = await procRoot(
      [row(PORT, OWNER, 9_001)],
      [{ pid: SUPERVISOR, ppid: 1, fds: ['/dev/null', 'pipe:[5]', 'socket:[9001]', 'socket:[7]'] }],
    );
    const subject = new ProcListenerProver({ procRoot: root, uid: () => OWNER });

    // Act
    const actual = await subject.prove(PORT, SUPERVISOR);

    // Assert
    should(actual).deepEqual({ kind: 'proven' });
  });

  it('should prove a listener held by a process the spawned one forked — x11vnc under timeout(1)', async () => {
    // Arrange: the supervisor holds no socket; its child does. Unrelated, vanished and garbled processes around.
    const root = await procRoot(
      [row(PORT, OWNER, 9_001)],
      [
        { pid: SUPERVISOR, ppid: 1, fds: ['pipe:[5]'], plainFd: true },
        { pid: FORKED, ppid: SUPERVISOR, fds: ['socket:[9001]'] },
        { pid: 102, ppid: FORKED },
        { pid: 200, ppid: 1, fds: ['socket:[9001]'] },
        { pid: 300, ppid: 1, stat: 'garbled' },
        { pid: 301, ppid: 1, stat: null },
      ],
    );
    const subject = new ProcListenerProver({ procRoot: root, uid: () => OWNER });

    // Act
    const actual = await subject.prove(PORT, SUPERVISOR);

    // Assert
    should(actual).deepEqual({ kind: 'proven' });
  });

  it('should name a stranger holding the port, and this user’s own unrelated program', async () => {
    // Arrange
    const squatted = await procRoot([row(PORT, STRANGER, 9_002)], [{ pid: SUPERVISOR, ppid: 1 }]);
    const collided = await procRoot(
      [row(PORT, OWNER, 9_003)],
      [
        { pid: SUPERVISOR, ppid: FORKED },
        { pid: FORKED, ppid: SUPERVISOR },
      ],
    );

    // Act
    const stranger = await new ProcListenerProver({ procRoot: squatted, uid: () => OWNER }).prove(PORT, SUPERVISOR);
    const own = await new ProcListenerProver({ procRoot: collided, uid: () => OWNER }).prove(PORT, SUPERVISOR);

    // Assert
    should(stranger).deepEqual({ kind: 'foreign', uid: STRANGER });
    should(own).deepEqual({ kind: 'foreign', uid: OWNER });
  });

  it('should call a port nobody listens on absent, even for a process that already exited', async () => {
    // Arrange
    const root = await procRoot([row(PORT + 1, OWNER, 9_001)], []);
    const subject = new ProcListenerProver({ procRoot: root, uid: () => OWNER });

    // Act
    const actual = await subject.prove(PORT, SUPERVISOR);

    // Assert
    should(actual).deepEqual({ kind: 'absent' });
  });

  it('should prove nothing on a host with no tables, or with no uid', async () => {
    // Arrange
    const bare = await procRoot(undefined, [{ pid: SUPERVISOR, ppid: 1 }]);
    const tabled = await procRoot([row(PORT, OWNER, 9_001)], [{ pid: SUPERVISOR, ppid: 1, fds: ['socket:[9001]'] }]);

    // Act
    const macos = await new ProcListenerProver({ procRoot: bare, uid: () => OWNER }).prove(PORT, SUPERVISOR);
    const uidless = await new ProcListenerProver({ procRoot: tabled, uid: () => undefined }).prove(PORT, SUPERVISOR);

    // Assert
    should(macos).deepEqual({ kind: 'unknown' });
    should(uidless).deepEqual({ kind: 'unknown' });
  });

  it('should name who holds a port, and nobody where nothing listens or nothing can be read', async () => {
    // Arrange
    const root = await procRoot([row(PORT, STRANGER, 9_002)], []);
    const bare = await procRoot(undefined, []);
    const subject = new ProcListenerProver({ procRoot: root, uid: () => OWNER });

    // Act
    const held = await subject.holder(PORT);
    const free = await subject.holder(PORT + 1);
    const unreadable = await new ProcListenerProver({ procRoot: bare }).holder(PORT);

    // Assert
    should(held).equal(STRANGER);
    should(free).be.undefined();
    should(unreadable).be.undefined();
  });

  it.if(process.platform === 'linux')("should prove a real listener against this host's own /proc", async () => {
    // Arrange: the test's own process holds the socket, so it is the "spawned" pid; any other pid is not.
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
    const subject = new ProcListenerProver();

    try {
      // Act
      const own = await subject.prove(server.port, process.pid);
      const other = await subject.prove(server.port, NO_SUCH_PID);

      // Assert
      should(own).deepEqual({ kind: 'proven' });
      should(other).deepEqual({ kind: 'foreign', uid: process.getuid?.() });
    } finally {
      server.stop(true);
    }
  });
});
