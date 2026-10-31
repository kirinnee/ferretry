import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ProgramProofPort, ProgramRunner, ProvenProgram } from '../../lib/input-requests/index.ts';
import { CODE_PROGRAMS, parseUids } from '../../lib/input-requests/index.ts';
import { recognisedConsumer } from '../../lib/input-requests/recognised.ts';
import { ExecutableCodePrograms } from './executable-code-programs.ts';

/** What the kernel says about processes and a TTY, one reading each. `undefined` (or a throw) is "cannot tell". */
export interface ProcessHost {
  /** The effective and real uid a process runs with. */
  uids(pid: number): Promise<{ readonly effective: number; readonly real: number } | undefined>;
  /** The name the kernel keeps for a process: only the process itself can change it. */
  name(pid: number): Promise<string | undefined>;
  /**
   * The name of the program a process runs, PROVED from its executable and a root-controlled bin folder, and only a
   * {@link READER_PROGRAMS} one: a root folder holds bash too.
   */
  executable(pid: number): Promise<string | undefined>;
  /** Whether a process whose controlling terminal is not `ttyPath` holds it open. */
  heldElsewhere(ttyPath: string): Promise<boolean | undefined>;
}

/**
 * The programs a terminal's reader is proved as by its executable: one that asks for a secret, or a code program. A
 * proved `bash` is still bash, so anything else stays unproved and the card unverified.
 */
export const READER_PROGRAMS = (name: string): boolean => recognisedConsumer(name) || CODE_PROGRAMS.has(name);

/** A program name the kernel can report: no slash, no control character, at most 64 characters. */
const NAME = /^[^/\p{Cc}\p{Cf}]{1,64}$/u;
const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/u;

/**
 * WHO CAN READ A TERMINAL, AS THE KERNEL PROVES IT — never from the name `ps` shows, which any process can rewrite
 * (`printf sudo > /proc/$$/comm`) and which on macOS is argv[0] (`exec -a sudo bash`).
 *
 * A process's program is proved one of two ways, or not at all:
 *
 * - It runs SETUID ROOT right now (effective uid 0, real uid not). Only a root-owned setuid file gives that, and a
 *   ferret cannot make one. Its name is the kernel's for it: a ferret can only choose it through the link it starts the
 *   program by, and whatever it is called, what reads the terminal is a program root put there. Such a process is not
 *   dumpable, so its executable cannot be read and this is the only proof it can have. A process root runs outright
 *   (real uid 0, as `sudo -n bash` leaves one) is NOT proved: it could be anything a ferret with a cached sudo
 *   started, and its executable cannot be read either.
 * - Linux only: its executable (`/proc/<pid>/exe`, kept by the kernel) IS what a root-controlled bin folder resolves its
 *   name to, through parts this account cannot change (executable-code-programs.ts, `provenRootProgram`), and the
 *   name is one of {@link READER_PROGRAMS}.
 *
 * A TTY also counts as held elsewhere when a process outside its session opened it: the pty belongs to this account,
 * so a ferret can `cat /dev/pts/N` from another terminal and read past job control. Linux reads `/proc/<pid>/fd` of
 * every process it may (another account's are not readable, and cannot open this pty for reading unless root); macOS
 * asks `lsof`. Anything that cannot be read is unproven, so the card stays unverified.
 */
export class KernelProgramProof implements ProgramProofPort {
  constructor(private readonly host: ProcessHost) {}

  static forPlatform(platform: string, run: ProgramRunner, account?: number): KernelProgramProof {
    if (platform === 'linux') return new KernelProgramProof(linuxHost(account));
    if (platform === 'darwin') return new KernelProgramProof(darwinHost(run));
    return new KernelProgramProof(UNPROVEN);
  }

  async prove(pid: number): Promise<ProvenProgram | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const uids = await this.host.uids(pid).catch(() => undefined);
    if (uids === undefined) return undefined;
    if (uids.effective === 0 && uids.real !== 0) {
      const name = await this.host.name(pid).catch(() => undefined);
      // Read again: a process that dropped root between the two readings is not one that ran setuid root.
      const again = await this.host.uids(pid).catch(() => undefined);
      if (name === undefined || !NAME.test(name) || again?.effective !== 0 || again.real === 0) return undefined;
      return { name, setuidRoot: true };
    }
    if (uids.real === 0) return undefined;
    const name = await this.host.executable(pid).catch(() => undefined);
    return name !== undefined && NAME.test(name) ? { name, setuidRoot: false } : undefined;
  }

  async heldElsewhere(ttyPath: string): Promise<boolean | undefined> {
    if (!TTY_PATH.test(ttyPath)) return undefined;
    return await this.host.heldElsewhere(ttyPath).catch(() => undefined);
  }
}

const UNPROVEN: ProcessHost = {
  uids: async () => undefined,
  name: async () => undefined,
  executable: async () => undefined,
  heldElsewhere: async () => undefined,
};

/** `Uid:` of `/proc/<pid>/status`: real, effective, saved, filesystem. */
export function parseStatusUids(status: string): { readonly effective: number; readonly real: number } | undefined {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s*$/mu.exec(status);
  return match === null ? undefined : { real: Number(match[1]), effective: Number(match[2]) };
}

/**
 * The controlling terminal (`tty_nr`, field 7) of `/proc/<pid>/stat`, read after the LAST `)`: the name before it is
 * the process's own and may hold spaces and parentheses.
 */
export function parseStatTty(line: string): number | undefined {
  const fields = line.slice(line.lastIndexOf(')') + 2).split(' ');
  const tty = fields[4];
  return tty !== undefined && /^-?\d+$/u.test(tty) ? Number(tty) : undefined;
}

function linuxHost(account: number | undefined): ProcessHost {
  const executables = ExecutableCodePrograms.forPlatform('linux', account);
  return {
    uids: async pid => parseStatusUids(await readFile(`/proc/${String(pid)}/status`, 'utf8')),
    name: async pid => (await readFile(`/proc/${String(pid)}/comm`, 'utf8')).replace(/\n$/u, ''),
    executable: async pid => await executables.provenRootProgram(pid, READER_PROGRAMS),
    heldElsewhere: async ttyPath => {
      // The device number the kernel files as a controlling terminal is the same encoding `stat` gives as rdev.
      const device = (await stat(ttyPath)).rdev;
      const pids = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/u.test(name) && Number(name) !== process.pid);
      const holders = await Promise.all(
        pids.map(async pid => {
          const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
          for (const fd of fds)
            if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)) === ttyPath) {
              const line = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
              // A holder whose controlling terminal cannot be read counts as one elsewhere.
              return line === undefined ? true : parseStatTty(line) !== device;
            }
          return false;
        }),
      );
      return holders.some(Boolean);
    },
  };
}

function darwinHost(run: ProgramRunner): ProcessHost {
  return {
    uids: async pid => {
      const output = await run(['ps', '-o', 'uid=,ruid=', '-p', String(pid)]);
      return output === undefined ? undefined : parseUids(output);
    },
    // `ps -o comm=` is argv[0] on macOS. Asked only of a process that runs setuid root, whose program root placed.
    name: async pid => {
      const output = await run(['ps', '-o', 'comm=', '-p', String(pid)]);
      const name = output === undefined ? '' : basename(output.trim());
      return name === '' ? undefined : name;
    },
    // GAP: no reading of a macOS process's executable is wired, so nothing but a setuid program is proved there.
    executable: async () => undefined,
    heldElsewhere: async ttyPath => {
      // `lsof` exits non-zero when it finds nothing, and the pane's own shell always holds its TTY: no answer is unknown.
      const listed = await run(['lsof', '-t', '--', ttyPath]);
      if (listed === undefined) return undefined;
      const pids = listed
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^[1-9][0-9]*$/u.test(line) && Number(line) !== process.pid);
      if (pids.length === 0) return undefined;
      const terminals = await run(['ps', '-o', 'pid=,tty=', '-p', pids.join(',')]);
      if (terminals === undefined) return undefined;
      const own = basename(ttyPath);
      const seen = new Map(
        terminals
          .split('\n')
          .map(line => line.trim().split(/\s+/u))
          .filter(([pid]) => pid !== undefined && pid !== '')
          .map(([pid = '', tty = '']) => [pid, tty] as const),
      );
      // A holder `ps` no longer lists has gone; one that `ps` shows on another terminal, or none, is elsewhere.
      return [...seen.values()].some(tty => tty !== own);
    },
  };
}
