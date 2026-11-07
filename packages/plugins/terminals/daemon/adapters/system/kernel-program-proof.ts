import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';
import type { ProfileProgram, ProgramProofPort, ProgramRunner, ProvenProgram } from '../../lib/input-requests/index.ts';
import { GETPASS_PROGRAMS, parseUids } from '../../lib/input-requests/index.ts';
import { accountName } from '../terminal/system-login-shell.ts';
import { ExecutableCodePrograms } from './executable-code-programs.ts';
import { profileChainOf, profileProgramOf } from './profile-program.ts';
import { replaceableBy } from './replaceable-file.ts';

/** What the kernel says about processes and a TTY, one reading each. `undefined` (or a throw) is "cannot tell". */
export interface ProcessHost {
  /** The effective and real uid a process runs with. */
  uids(pid: number): Promise<{ readonly effective: number; readonly real: number } | undefined>;
  /**
   * The name a process runs under: on Linux the last part of the path it was STARTED by (a link's name, not the file's),
   * on macOS its argv[0]. Whoever starts the program chooses it.
   */
  name(pid: number): Promise<string | undefined>;
  /** The name of the program a process runs, PROVED from its executable and a root-controlled bin folder. */
  executable(pid: number): Promise<string | undefined>;
  /** Whether a process whose controlling terminal is not `ttyPath` holds it open. */
  heldElsewhere(ttyPath: string): Promise<boolean | undefined>;
  /** The program a process runs, proved only through the owner's own profile (profile-program.ts). */
  profile?(pid: number): Promise<ProfileProgram | undefined>;
}

/**
 * Every name an executable may be proved as. The exe proof establishes WHICH system program runs (bash in /usr/bin is
 * proved to be bash); what that name is worth is each consumer's decision: green needs a program that asks for a
 * secret, the short lock a setuid getpass one, a secure-copy rule the program it names.
 */
const ANY_NAME = (): boolean => true;

/** A program name the kernel can report: no slash, no control character, at most 64 characters. */
const NAME = /^[^/\p{Cc}\p{Cf}]{1,64}$/u;
const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/u;

/**
 * WHO CAN READ A TERMINAL, AS THE KERNEL PROVES IT — never from the name `ps` shows, which any process can rewrite
 * (`printf sudo > /proc/$$/comm`) and which on macOS is argv[0] (`exec -a sudo bash`).
 *
 * A process's program is proved one of two ways, or not at all:
 *
 * - It runs SETUID ROOT right now (effective uid 0, real uid not), under a getpass name (sudo, sudoedit, su, doas,
 *   passwd). Only a root-owned setuid file gives those uids, and a ferret cannot make one. The NAME is not proof:
 *   whoever starts the program picks it (a link's name on Linux, any argv[0] on macOS), so a ferret can start some other
 *   setuid program as `sudo`. What reads the terminal is still a program root put there; anything else setuid is not
 *   proved at all. Such a process is not dumpable, so its executable cannot be read and this is the only proof it can
 *   have. A process root runs outright (real uid 0, as `sudo -n bash` leaves one) is NOT proved: it could be anything
 *   a ferret with a cached sudo started, and its executable cannot be read either.
 * - Linux only: its executable (`/proc/<pid>/exe`, kept by the kernel) IS what a root-controlled bin folder resolves its
 *   name to, through parts this account cannot change (executable-code-programs.ts, `provenRootProgram`). Any name:
 *   a proved bash is bash, and every consumer decides what a name is worth.
 *
 * A TTY also counts as held elsewhere when a process outside its session opened it: the pty belongs to this account,
 * so a ferret can `cat /dev/pts/N` from another terminal and read past job control. Linux reads every process's
 * `/proc/<pid>/fd` and matches the DEVICE each descriptor reaches; macOS asks `lsof`. A process of this account whose
 * descriptors cannot be read (it made itself not dumpable) makes the answer unknown, so the card stays unverified.
 * It is a look at one moment and best effort against a process of this same account: a TTY opened after the look, or
 * held outside any descriptor table, is not seen.
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
      if (name === undefined || !GETPASS_PROGRAMS.has(name) || again?.effective !== 0 || again.real === 0)
        return undefined;
      return { name, setuidRoot: true };
    }
    if (uids.real === 0) return undefined;
    const name = await this.host.executable(pid).catch(() => undefined);
    return name !== undefined && NAME.test(name) ? { name, setuidRoot: false } : undefined;
  }

  /**
   * The program a process runs, proved through the owner's own Nix profile ONLY. Never for a process running setuid or
   * as root: those are proved, or not, by {@link prove}.
   */
  async proveProfile(pid: number): Promise<ProfileProgram | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.host.profile === undefined) return undefined;
    const uids = await this.host.uids(pid).catch(() => undefined);
    if (uids === undefined || uids.real === 0 || uids.effective !== uids.real) return undefined;
    return await this.host.profile(pid).catch(() => undefined);
  }

  async heldElsewhere(ttyPath: string): Promise<boolean | undefined> {
    if (!TTY_PATH.test(ttyPath)) return undefined;
    return await this.host.heldElsewhere(ttyPath).catch(() => undefined);
  }
}

/** A platform with no reading wired: nothing is proved and nobody is known not to hold the TTY. */
export const UNPROVEN: ProcessHost = {
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
  return statField(line, 7);
}

/** When a process started (`starttime`, field 22 of `/proc/<pid>/stat`), in clock ticks since boot. */
export function parseStatStart(line: string): number | undefined {
  return statField(line, 22);
}

/** Field `n` (1-based, as proc(5) numbers them) of a `/proc/<pid>/stat` line, read after the LAST `)`. */
function statField(line: string, n: number): number | undefined {
  const field = line.slice(line.lastIndexOf(')') + 2).split(' ')[n - 3];
  return field !== undefined && /^-?\d+$/u.test(field) ? Number(field) : undefined;
}

/** `PPid:` of `/proc/<pid>/status`. */
function parseStatusParent(status: string): number | undefined {
  const match = /^PPid:\s+(\d+)\s*$/mu.exec(status);
  return match === null ? undefined : Number(match[1]);
}

/** What the stranger scan reads under `/proc`. Every method may throw; what each throw means is the scan's to decide. */
export interface ProcFiles {
  /** The device number `stat` gives for the TTY's path. */
  device(ttyPath: string): Promise<number>;
  pids(): Promise<readonly number[]>;
  /** The descriptors a process holds: throws when they cannot be read. */
  fds(pid: number): Promise<readonly string[]>;
  /** A descriptor's link text, for skipping sockets and pipes without a stat. */
  link(pid: number, fd: string): Promise<string>;
  /** What a descriptor reaches: whether it is a character device, and which. */
  reaches(pid: number, fd: string): Promise<{ readonly character: boolean; readonly device: number }>;
  status(pid: number): Promise<string>;
  stat(pid: number): Promise<string>;
  /** The file a process runs (`/proc/<pid>/exe`). */
  executable(pid: number): Promise<string>;
  /** The name the kernel keeps for a process (`/proc/<pid>/comm`). */
  name(pid: number): Promise<string>;
  /** A process's children (`/proc/<pid>/task/<pid>/children`). */
  children(pid: number): Promise<readonly number[]>;
  /** Whether this account could change or replace a file (replaceable-file.ts). */
  replaceable(path: string): Promise<boolean>;
}

/** Clock ticks (100 a second) within which systemd forks its login helper after it starts. */
const AT_START_TICKS = 100;

/**
 * systemd's own PAM helper, `(sd-pam)`: the one process of this account every systemd login has whose descriptors
 * cannot be read (forked as root, then it dropped to this account and never ran another program). Singled out by the
 * kernel, its name only one check among them: its parent runs a root-owned `systemd` this account cannot replace (the
 * user's service manager), it started within a second of that parent, it is that parent's EARLIEST child (systemd
 * forks it before anything else, and other children can start in that same second), and it is called `(sd-pam)`. A
 * process a ferret hides (`prctl(PR_SET_DUMPABLE, 0)`, or one `systemd-run --user` starts) fails at least one.
 */
async function systemdLoginHelper(files: ProcFiles, pid: number, status: string): Promise<boolean> {
  const parent = parseStatusParent(status);
  if (parent === undefined || parent <= 1) return false;
  const runs = await files.executable(parent).catch(() => undefined);
  if (runs === undefined || basename(runs) !== 'systemd') return false;
  if (await files.replaceable(runs).catch(() => true)) return false;
  const [own, theirs] = await Promise.all(
    [files.stat(pid), files.stat(parent)].map(async line => await line.catch(() => '')),
  );
  const started = parseStatStart(own ?? '');
  const parentStarted = parseStatStart(theirs ?? '');
  if (started === undefined || parentStarted === undefined) return false;
  if (started < parentStarted || started - parentStarted > AT_START_TICKS) return false;
  if ((await files.name(pid).catch(() => undefined))?.trim() !== SD_PAM) return false;
  return await earliestChild(files, parent, pid, started);
}

/** systemd's PAM helper as the kernel names it. */
const SD_PAM = '(sd-pam)';

/** `pid` is `parent`'s child, and every other child started strictly later (one that has gone is passed over). */
async function earliestChild(files: ProcFiles, parent: number, pid: number, started: number): Promise<boolean> {
  const children = await files.children(parent).catch(() => undefined);
  if (children?.includes(pid) !== true) return false;
  const others = await Promise.all(
    children.filter(child => child !== pid).map(async child => parseStatStart(await files.stat(child).catch(() => ''))),
  );
  return others.every(other => other === undefined || other > started);
}

/** A descriptor that is never a terminal: no stat needed. */
const NOT_A_DEVICE = /^(?:socket|pipe|anon_inode):/u;

/**
 * Whether a process whose controlling terminal is not the TTY holds it open, matching every descriptor by the DEVICE it
 * reaches (not by how its path is spelled). `undefined` when a process of this account cannot be looked at. A process
 * running setuid root, or as another account, whose descriptors cannot be read is passed over: the first is a program
 * root placed, the second cannot open this account's pty for reading unless it is root (both declared).
 */
export async function strangerHolds(
  files: ProcFiles,
  ttyPath: string,
  account: number | undefined,
  self: number,
): Promise<boolean | undefined> {
  const device = await files.device(ttyPath);
  const pids = (await files.pids()).filter(pid => pid !== self);
  const seen = await Promise.all(
    pids.map(async (pid): Promise<'elsewhere' | 'unknown' | 'clear'> => {
      let fds: readonly string[];
      try {
        fds = await files.fds(pid);
      } catch {
        const status = await files.status(pid).catch(() => '');
        const uids = parseStatusUids(status);
        // No status: the process has gone.
        if (uids === undefined) return 'clear';
        if (uids.effective === 0 && uids.real !== 0) return 'clear';
        const ours = account === undefined || uids.effective === account || uids.real === account;
        if (!ours) return 'clear';
        return (await systemdLoginHelper(files, pid, status)) ? 'clear' : 'unknown';
      }
      for (const fd of fds) {
        const link = await files.link(pid, fd).catch(() => undefined);
        if (link !== undefined && NOT_A_DEVICE.test(link)) continue;
        const reached = await files.reaches(pid, fd).catch(() => undefined);
        // A descriptor that could not be stat'ed (closed meanwhile) counts only when its link text names the TTY.
        const holds = reached === undefined ? link === ttyPath : reached.character && reached.device === device;
        if (!holds) continue;
        const line = await files.stat(pid).catch(() => undefined);
        // A holder whose controlling terminal cannot be read counts as one elsewhere.
        return line === undefined || parseStatTty(line) !== device ? 'elsewhere' : 'clear';
      }
      return 'clear';
    }),
  );
  if (seen.includes('elsewhere')) return true;
  return seen.includes('unknown') ? undefined : false;
}

/** The real `/proc`, as the stranger scan reads it on Linux. */
export const PROC_FILES: ProcFiles = {
  device: async ttyPath => (await stat(ttyPath)).rdev,
  pids: async () => (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/u.test(name)).map(name => Number(name)),
  fds: async pid => await readdir(`/proc/${String(pid)}/fd`),
  link: async (pid, fd) => await readlink(`/proc/${String(pid)}/fd/${fd}`),
  reaches: async (pid, fd) => {
    const found = await stat(`/proc/${String(pid)}/fd/${fd}`);
    return { character: found.isCharacterDevice(), device: found.rdev };
  },
  status: async pid => await readFile(`/proc/${String(pid)}/status`, 'utf8'),
  stat: async pid => await readFile(`/proc/${String(pid)}/stat`, 'utf8'),
  executable: async pid => await readlink(`/proc/${String(pid)}/exe`),
  name: async pid => await readFile(`/proc/${String(pid)}/comm`, 'utf8'),
  children: async pid =>
    (await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8'))
      .split(/\s+/u)
      .filter(word => /^[1-9][0-9]*$/u.test(word))
      .map(Number),
  replaceable: async path => await replaceableBy(process.getuid?.(), path),
};

/** Linux: `/proc` for the uids, the name and the scan; the exe proof for the program. */
export function linuxHost(account: number | undefined): ProcessHost {
  const executables = ExecutableCodePrograms.forPlatform('linux', account);
  return {
    uids: async pid => parseStatusUids(await readFile(`/proc/${String(pid)}/status`, 'utf8')),
    name: async pid => (await readFile(`/proc/${String(pid)}/comm`, 'utf8')).replace(/\n$/u, ''),
    executable: async pid => await executables.provenRootProgram(pid, ANY_NAME),
    heldElsewhere: async ttyPath => await strangerHolds(PROC_FILES, ttyPath, account, process.pid),
    profile: async pid => {
      const chain = profileChainOf(
        homedir(),
        accountName(() => userInfo().username),
      );
      const runs = await readlink(`/proc/${String(pid)}/exe`);
      return chain === undefined ? undefined : await profileProgramOf(runs, chain, account, { lstat, readlink });
    },
  };
}

/** macOS: `ps` for the uids and the name, `lsof` and `ps` for the scan; no executable reading (GAP). */
export function darwinHost(run: ProgramRunner): ProcessHost {
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
