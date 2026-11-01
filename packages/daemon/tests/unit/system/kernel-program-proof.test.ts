import { describe, it } from 'bun:test';
import should from 'should';
import {
  KernelProgramProof,
  type ProcessHost,
  parseStatStart,
  parseStatTty,
  type ProcFiles,
  parseStatusUids,
  strangerHolds,
} from '../../../src/adapters/system/kernel-program-proof.ts';

type Uids = { readonly effective: number; readonly real: number };

/** A host whose answers a test sets per pid; anything not set cannot be told. */
function host(
  facts: {
    readonly uids?: Record<number, Uids | readonly Uids[]>;
    readonly names?: Record<number, string>;
    readonly executables?: Record<number, string>;
    readonly elsewhere?: boolean;
  } = {},
): ProcessHost & { readonly read: Record<number, number> } {
  const read: Record<number, number> = {};
  return {
    read,
    uids: async pid => {
      const answer = facts.uids?.[pid];
      if (answer === undefined || !Array.isArray(answer)) return answer as Uids | undefined;
      const index = read[pid] ?? 0;
      read[pid] = index + 1;
      return answer[Math.min(index, answer.length - 1)];
    },
    name: async pid => facts.names?.[pid],
    executable: async pid => facts.executables?.[pid],
    heldElsewhere: async () => facts.elsewhere,
  };
}

const SETUID: Uids = { effective: 0, real: 1000 };
const USER: Uids = { effective: 1000, real: 1000 };
const ROOT: Uids = { effective: 0, real: 0 };

describe('proving the program a process runs', () => {
  it('should prove a setuid-root process by the kernel name, as setuid root', async () => {
    const proof = new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: 'sudo' } }));
    should(await proof.prove(7)).eql({ name: 'sudo', setuidRoot: true });
  });

  it('should never prove a process root runs outright, whatever it is called (sudo -n bash)', async () => {
    const proof = new KernelProgramProof(host({ uids: { 7: ROOT }, names: { 7: 'sudo' }, executables: { 7: 'sudo' } }));
    should(await proof.prove(7)).be.undefined();
  });

  it("should prove a user's process only from its executable, never from its name", async () => {
    // A shell that wrote sudo into its own comm: the kernel name says sudo, the executable proves nothing.
    const renamed = new KernelProgramProof(host({ uids: { 7: USER }, names: { 7: 'sudo' } }));
    should(await renamed.prove(7)).be.undefined();
    const ssh = new KernelProgramProof(host({ uids: { 7: USER }, names: { 7: 'bash' }, executables: { 7: 'ssh' } }));
    should(await ssh.prove(7)).eql({ name: 'ssh', setuidRoot: false });
  });

  it('should not prove a process that dropped root between the two readings', async () => {
    const proof = new KernelProgramProof(host({ uids: { 7: [SETUID, USER] }, names: { 7: 'sudo' } }));
    should(await proof.prove(7)).be.undefined();
  });

  it('should not prove an unreadable process, a bad pid, a bad name or a throwing host', async () => {
    should(await new KernelProgramProof(host()).prove(7)).be.undefined();
    should(await new KernelProgramProof(host({ uids: { 0: SETUID }, names: { 0: 'sudo' } })).prove(0)).be.undefined();
    for (const name of ['', 'a/b', 'su\u0007do', 'x'.repeat(65)])
      should(await new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: name } })).prove(7)).be.undefined();
    const throwing: ProcessHost = {
      uids: async () => await Promise.reject(new Error('EACCES')),
      name: async () => 'sudo',
      executable: async () => 'sudo',
      heldElsewhere: async () => await Promise.reject(new Error('EACCES')),
    };
    should(await new KernelProgramProof(throwing).prove(7)).be.undefined();
    should(await new KernelProgramProof(throwing).heldElsewhere('/dev/pts/3')).be.undefined();
  });

  it('should prove a setuid-root process only under a getpass name: any other is unproved (L3)', async () => {
    for (const name of ['sudo', 'sudoedit', 'su', 'doas', 'passwd'])
      should(await new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: name } })).prove(7)).eql({
        name,
        setuidRoot: true,
      });
    for (const name of ['ping', 'chfn', 'newgrp', 'pkexec', 'fusermount3'])
      should(await new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: name } })).prove(7)).be.undefined();
  });

  it('should prove any system program by its executable, bash included: each decision weighs the name', async () => {
    const proof = new KernelProgramProof(host({ uids: { 7: USER }, executables: { 7: 'bash' } }));
    should(await proof.prove(7)).eql({ name: 'bash', setuidRoot: false });
  });

  it('should pass on who else holds the TTY, and refuse a path that is not a TTY path', async () => {
    should(await new KernelProgramProof(host({ elsewhere: true })).heldElsewhere('/dev/pts/3')).be.true();
    should(await new KernelProgramProof(host({ elsewhere: false })).heldElsewhere('/dev/pts/3')).be.false();
    should(await new KernelProgramProof(host({ elsewhere: false })).heldElsewhere('/dev/pts/3;rm')).be.undefined();
  });

  it('should prove nothing on a platform it has no reading for', async () => {
    const proof = KernelProgramProof.forPlatform('win32', async () => '0 1000');
    should(await proof.prove(process.pid)).be.undefined();
    should(await proof.heldElsewhere('/dev/pts/3')).be.undefined();
  });
});

describe('reading the kernel', () => {
  it('should read the real and effective uid from /proc/<pid>/status', () => {
    should(parseStatusUids('Name:\tsudo\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\n')).eql({
      real: 1000,
      effective: 0,
    });
    should(parseStatusUids('Name:\tbash\n')).be.undefined();
  });

  it('should read the controlling terminal after the last parenthesis, whatever the name holds', () => {
    should(parseStatTty('42 (a) b) (c) S 1 42 42 34825 42 4194560')).equal(34825);
    should(parseStatTty('42 (bash) S 1 42 42 0 -1 4194560')).equal(0);
    should(parseStatTty('garbage')).be.undefined();
    should(parseStatStart('7 (x) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 801 0')).equal(801);
  });

  it('should, on Linux, prove this test process is no reader and see /dev/null held by processes of no terminal', async () => {
    if (process.platform !== 'linux') return;
    const proof = KernelProgramProof.forPlatform('linux', async () => undefined, process.getuid?.());
    // bun is not a program that asks for a secret, wherever it was started from.
    should(await proof.prove(process.pid)).be.undefined();
    // Not a TTY, but the scan is the same: many processes hold /dev/null with no controlling terminal of its number.
    should(await proof.heldElsewhere('/dev/null')).be.true();
  });
});

describe('the macOS readings', () => {
  const runner = (answers: Record<string, string | undefined>) => {
    const asked: string[] = [];
    return {
      asked,
      run: async (argv: readonly string[]) => {
        asked.push(argv.join(' '));
        return answers[argv.join(' ')];
      },
    };
  };

  it('should prove only a setuid-root process, by ps', async () => {
    const { run } = runner({
      'ps -o uid=,ruid= -p 7': '    0   501\n',
      'ps -o comm= -p 7': '/usr/bin/sudo\n',
      'ps -o uid=,ruid= -p 8': '  501   501\n',
      'ps -o comm= -p 8': '/usr/bin/ssh\n',
    });
    const proof = KernelProgramProof.forPlatform('darwin', run);
    should(await proof.prove(7)).eql({ name: 'sudo', setuidRoot: true });
    // GAP: no reading of a macOS executable is wired, so ssh is never proved there.
    should(await proof.prove(8)).be.undefined();
  });

  it('should take a setuid process started with argv[0] sudo as sudo: the caller picks the name (declared GAP)', async () => {
    // `exec -a sudo /usr/bin/<another setuid program>`: ps -o comm= is argv[0] on macOS. Root placed what reads; the
    // name is not proof of which program it is, which docs/input-requests.md says.
    const { run } = runner({ 'ps -o uid=,ruid= -p 9': '0 501\n', 'ps -o comm= -p 9': 'sudo\n' });
    should(await KernelProgramProof.forPlatform('darwin', run).prove(9)).eql({ name: 'sudo', setuidRoot: true });
  });

  it('should find a holder on another terminal with lsof and ps, and fail closed when either cannot answer', async () => {
    const tty = '/dev/ttys003';
    const alone = runner({
      'lsof -t -- /dev/ttys003': '100\n101\n',
      'ps -o pid=,tty= -p 100,101': '100 ttys003\n101 ttys003\n',
    });
    should(await KernelProgramProof.forPlatform('darwin', alone.run).heldElsewhere(tty)).be.false();
    const stranger = runner({
      'lsof -t -- /dev/ttys003': '100\n102\n',
      'ps -o pid=,tty= -p 100,102': '100 ttys003\n102 ttys009\n',
    });
    should(await KernelProgramProof.forPlatform('darwin', stranger.run).heldElsewhere(tty)).be.true();
    const detached = runner({
      'lsof -t -- /dev/ttys003': '100\n103\n',
      'ps -o pid=,tty= -p 100,103': '100 ttys003\n103 ??\n',
    });
    should(await KernelProgramProof.forPlatform('darwin', detached.run).heldElsewhere(tty)).be.true();
    should(await KernelProgramProof.forPlatform('darwin', runner({}).run).heldElsewhere(tty)).be.undefined();
    const psFails = runner({ 'lsof -t -- /dev/ttys003': '100\n' });
    should(await KernelProgramProof.forPlatform('darwin', psFails.run).heldElsewhere(tty)).be.undefined();
  });
});

describe('who else holds the terminal, from /proc', () => {
  const TTY = '/dev/pts/9';
  const DEVICE = 34_825;
  const ME = 1000;

  interface Proc {
    readonly fds?: Record<string, { readonly link: string; readonly device?: number; readonly character?: boolean }>;
    /** The descriptors cannot be read: the process is not dumpable, or another account's. */
    readonly hidden?: boolean;
    readonly uids?: readonly [real: number, effective: number];
    readonly tty?: number;
    readonly parent?: number;
    readonly started?: number;
    readonly runs?: string;
    readonly comm?: string;
    readonly kids?: readonly number[];
  }

  const files = (procs: Record<number, Proc>): ProcFiles => ({
    device: async () => DEVICE,
    pids: async () => Object.keys(procs).map(Number),
    fds: async pid => {
      const proc = procs[pid];
      if (proc === undefined || proc.hidden === true) throw new Error('EACCES');
      return Object.keys(proc.fds ?? {});
    },
    link: async (pid, fd) => procs[pid]?.fds?.[fd]?.link ?? (await Promise.reject(new Error('ENOENT'))),
    reaches: async (pid, fd) => {
      const found = procs[pid]?.fds?.[fd];
      if (found?.device === undefined) throw new Error('ENOENT');
      return { character: found.character ?? true, device: found.device };
    },
    status: async pid => {
      const uids = procs[pid]?.uids;
      if (uids === undefined) throw new Error('ENOENT');
      return `Name:\tx\nPPid:\t${procs[pid]?.parent ?? 1}\nUid:\t${uids[0]}\t${uids[1]}\t${uids[1]}\t${uids[1]}\n`;
    },
    // Fields 3–22 of proc(5): state … tty_nr (7) … starttime (22).
    stat: async pid =>
      `${pid} (a (b)) S 1 ${pid} ${pid} ${procs[pid]?.tty ?? 0} -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${procs[pid]?.started ?? 5000} 0`,
    executable: async pid => procs[pid]?.runs ?? (await Promise.reject(new Error('EACCES'))),
    replaceable: async path => !path.startsWith('/usr/lib/'),
    name: async pid => procs[pid]?.comm ?? (await Promise.reject(new Error('ENOENT'))),
    children: async pid => procs[pid]?.kids ?? (await Promise.reject(new Error('ENOENT'))),
  });
  const shell: Proc = { fds: { '0': { link: TTY, device: DEVICE } }, uids: [ME, ME], tty: DEVICE };
  const scan = async (procs: Record<number, Proc>) => await strangerHolds(files(procs), TTY, ME, 1);

  it('should find none when only processes of the terminal hold it, and skip sockets, pipes and other devices', async () => {
    should(
      await scan({
        10: shell,
        11: {
          fds: { '1': { link: 'socket:[42]' }, '2': { link: 'pipe:[43]' }, '3': { link: '/dev/null', device: 259 } },
        },
      }),
    ).be.false();
  });

  it('should find a process of another session holding it (cat /dev/pts/9 from another terminal)', async () => {
    should(await scan({ 10: shell, 12: { fds: { '0': { link: TTY, device: DEVICE } }, tty: 34_830 } })).be.true();
  });

  it('should match a holder by the DEVICE it reaches, whatever its path text says (L1)', async () => {
    // Another mount of devpts, a path through a link: the text differs, the device is the TTY.
    should(await scan({ 10: shell, 12: { fds: { '5': { link: '/mnt/pts/9', device: DEVICE } }, tty: 0 } })).be.true();
    // A character device of another number is not the TTY, whatever its text.
    should(await scan({ 10: shell, 12: { fds: { '5': { link: TTY, device: 34_999 } }, tty: 0 } })).be.false();
  });

  it('should be unknown when a process of this account hides its descriptors (made itself not dumpable) (M1)', async () => {
    should(await scan({ 10: shell, 13: { hidden: true, uids: [ME, ME] } })).be.undefined();
    should(await strangerHolds(files({ 13: { hidden: true, uids: [ME, ME] } }), TTY, undefined, 1)).be.undefined();
  });

  it('should pass over a hidden setuid-root process, another account, and one that has gone', async () => {
    should(
      await scan({
        10: shell,
        14: { hidden: true, uids: [ME, 0] },
        15: { hidden: true, uids: [1001, 1001] },
        16: { hidden: true },
      }),
    ).be.false();
  });

  it("should pass over systemd's own login helper (sd-pam), told apart by its parent and start, not its name", async () => {
    // The user's service manager: a root-owned systemd this account cannot replace, started at login.
    const manager: Proc = { fds: {}, uids: [ME, ME], runs: '/usr/lib/systemd/systemd', started: 798, kids: [21] };
    const helper: Proc = { hidden: true, uids: [ME, ME], parent: 20, started: 801, comm: '(sd-pam)' };
    should(await scan({ 10: shell, 20: manager, 21: helper })).be.false();
    // A process systemd-run started long after login, or a hider whose parent is a replaceable "systemd", is unknown.
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, started: 98_000 } })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, runs: '/home/me/systemd' }, 21: helper })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, runs: '/usr/lib/systemd/bash' }, 21: helper })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, runs: undefined }, 21: helper })).be.undefined();
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, started: 700 } })).be.undefined();
    // R1: only the manager's EARLIEST child, and only under its own name. A second hidden child of the manager that
    // started within the same first second stays unknown, and so does one that took the name.
    const second: Proc = { ...helper, started: 820 };
    should(await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: second })).be.undefined();
    should(
      await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: { fds: {}, started: 801 } }),
    ).be.undefined();
    should(
      await scan({
        10: shell,
        20: { ...manager, kids: [21, 22] },
        21: { ...helper, started: 830 },
        22: { fds: {}, started: 801 },
      }),
    ).be.undefined();
    should(
      await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: { fds: {}, started: 900 } }),
    ).be.false();
    should(await scan({ 10: shell, 20: { ...manager, kids: [21, 23] }, 21: helper })).be.false();
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, comm: 'sd-pam' } })).be.undefined();
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, comm: undefined } })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, kids: [22] }, 21: helper })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, kids: undefined }, 21: helper })).be.undefined();
  });

  it('should say held elsewhere over unknown, and leave the daemon itself out', async () => {
    should(
      await scan({ 13: { hidden: true, uids: [ME, ME] }, 12: { fds: { '0': { link: TTY, device: DEVICE } }, tty: 0 } }),
    ).be.true();
    should(
      await strangerHolds(files({ 1: { fds: { '0': { link: TTY, device: DEVICE } }, tty: 0 } }), TTY, ME, 1),
    ).be.false();
  });

  it('should count a descriptor that vanished between the listing and the stat only by its link text', async () => {
    should(await scan({ 12: { fds: { '0': { link: TTY } }, tty: 0 } })).be.true();
    should(await scan({ 12: { fds: { '0': { link: '/dev/pts/1' } }, tty: 0 } })).be.false();
  });
});
