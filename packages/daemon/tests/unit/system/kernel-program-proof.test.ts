import { describe, it } from 'bun:test';
import should from 'should';
import {
  KernelProgramProof,
  type ProcessHost,
  parseStatTty,
  parseStatusUids,
  READER_PROGRAMS,
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

  it('should prove a reader only as a program that asks for a secret or a code program, never bash', () => {
    for (const name of ['sudo', 'ssh', 'gpg', 'pinentry-curses', 'git-credential-osxkeychain', 'vault'])
      should(READER_PROGRAMS(name)).be.true();
    for (const name of ['bash', 'sh', 'zsh', 'python3', 'cat', 'node']) should(READER_PROGRAMS(name)).be.false();
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
