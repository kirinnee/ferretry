import { readlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { CODE_PROGRAMS, type CodeProgramPort } from '../../lib/input-requests/index.ts';
import { replaceableBy } from './replaceable-file.ts';

/**
 * The folders a program is trusted from: system folders this account cannot fill. A program counts only when the
 * file a process runs IS what one of these resolves `<folder>/<name>` to (the code exception here; secure copy reuses
 * the same list). Never a raw store path (any user can
 * `nix-store --add` a shell copy at `<hash>/bin/ssh`) and never a user profile. `/usr/local/bin` counts only when this
 * account cannot change it, which `replaceableBy` decides like for every other folder.
 */
export const ROOT_PROGRAM_FOLDERS: readonly string[] = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/run/current-system/sw/bin',
  '/nix/var/nix/profiles/default/bin',
];

/**
 * Whether a process runs a code program (`CODE_PROGRAMS`: ssh, scp, sftp, mosh, the aws, gcloud, az and vault CLIs)
 * from a system folder this account cannot replace. Decided from the REAL executable, never from the name `ps` shows:
 * a process can rewrite its own name (`printf ssh > /proc/$$/comm`) and a ferret can copy a shell to `~/bin/ssh` or add
 * one to the Nix store, so neither a name nor a root-owned store path is proof. Anything that cannot be read is no code
 * program, so the card stays a secret.
 */
export class ExecutableCodePrograms implements CodeProgramPort {
  constructor(
    /** The absolute path of the file a process runs, or nothing when it cannot be told. */
    private readonly executable: (pid: number) => Promise<string | undefined>,
    /** The real path a path resolves to, or nothing when it does not exist. */
    private readonly resolve: (path: string) => Promise<string | undefined>,
    /** Whether this account could change or replace a path (any part of it, or of what it resolves to). */
    private readonly replaceable: (path: string) => Promise<boolean>,
    private readonly folders: readonly string[] = ROOT_PROGRAM_FOLDERS,
  ) {}

  /**
   * The production wiring: `/proc/<pid>/exe` on Linux, which the kernel keeps and a process cannot rewrite. Every other
   * platform proves nothing, so an echo-off code prompt there is always a secret: on macOS `ps -o comm=` is not proven
   * to be the kernel's executable path rather than a name the process chose (`exec -a`), and no other reading is
   * wired. GAP: a macOS daemon never keeps an echo-off ssh code prompt a code.
   */
  static forPlatform(platform: string, account: number | undefined = process.getuid?.()): ExecutableCodePrograms {
    const executable = async (pid: number): Promise<string | undefined> =>
      platform === 'linux' ? await readlink(`/proc/${String(pid)}/exe`).catch(() => undefined) : undefined;
    return new ExecutableCodePrograms(
      executable,
      async path => await realpath(path).catch(() => undefined),
      async path => await replaceableBy(account, path),
    );
  }

  async codeProgram(pid: number): Promise<boolean> {
    return (await this.programOf(pid, CODE_PROGRAMS)) !== undefined;
  }

  /**
   * The name of the program a process runs, PROVED: the file it runs is what a root folder resolves that name to,
   * through an entry this account cannot change. Only a name in `names` when given. `undefined` when anything is
   * unproven or unreadable, so a caller fails closed. Note: a setuid process (sudo, su) is not dumpable, so its
   * executable cannot be read and it is never proved here; prove one of those by its uids instead.
   */
  async programOf(pid: number, names?: ReadonlySet<string>): Promise<string | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const path = await this.executable(pid).catch(() => undefined);
    // A deleted executable reads "<path> (deleted)" on Linux: it is not the file on disk any more.
    if (path === undefined || !isAbsolute(path) || path.endsWith(' (deleted)')) return undefined;
    const name = basename(path);
    if (names !== undefined && !names.has(name)) return undefined;
    const running = await this.resolve(path).catch(() => undefined);
    if (running === undefined) return undefined;
    for (const folder of this.folders) {
      const entry = `${folder}/${name}`;
      if ((await this.resolve(entry).catch(() => undefined)) !== running) continue;
      if (!(await this.replaceable(entry).catch(() => true))) return name;
    }
    return undefined;
  }
}
