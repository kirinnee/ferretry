import { readlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { CODE_PROGRAMS, type CodeProgramPort } from '../../lib/input-requests/index.ts';
import { replaceableBy } from './replaceable-file.ts';

/**
 * Whether a process runs a code program (`CODE_PROGRAMS`: ssh, scp, sftp, mosh, the aws, gcloud, az and vault CLIs)
 * from an executable this account cannot replace. Decided from the REAL executable, never from the name `ps` shows:
 * a process can rewrite its own name (`printf ssh > /proc/$$/comm`) and a ferret can copy a shell to `~/bin/ssh`, so a
 * name is no proof. The file must also pass the secure-copy rule (no part of its path owned by this account or open to
 * anyone): a store path under `/nix/store` or `/usr/bin` does, a copy in the home folder does not. Anything that cannot
 * be read is no code program, so the card stays a secret.
 */
export class ExecutableCodePrograms implements CodeProgramPort {
  constructor(
    /** The absolute path of the file a process runs, or nothing when it cannot be told. */
    private readonly executable: (pid: number) => Promise<string | undefined>,
    /** Whether this account could change or replace that file. */
    private readonly replaceable: (path: string) => Promise<boolean>,
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
    return new ExecutableCodePrograms(executable, async path => await replaceableBy(account, path));
  }

  async codeProgram(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const path = await this.executable(pid).catch(() => undefined);
    // A deleted executable reads "<path> (deleted)" on Linux: it is not the file on disk any more.
    if (path === undefined || !isAbsolute(path) || path.endsWith(' (deleted)')) return false;
    if (!CODE_PROGRAMS.has(basename(path))) return false;
    return !(await this.replaceable(path).catch(() => true));
  }
}
