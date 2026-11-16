import { closeSync, constants, openSync } from 'node:fs';

/**
 * THE PROCESS'S WORKING DIRECTORY, AS EVERY BRACKET THAT BORROWS IT SHARES IT.
 *
 * Two parts of this daemon install a held folder as the kernel's working directory for one synchronous step and then
 * put the runtime's own back: the session-file viewer's pinner and the provisioner's destination side
 * (`./descriptor-calls.ts`). The working directory is the PROCESS's, so a restore that fails is not one caller's
 * problem: until it is mended, everything else in the daemon — the other bracket, a child started without a `cwd`, any
 * relative path — would be standing in a folder an agent can write. So there is ONE of these per process, and a
 * failed restore is handled here, the same way for both:
 *
 *   1. fall back to `/`, which nobody's harness owns;
 *   2. if even that fails, stop the daemon — crash-only, rather than run on in the agent's folder;
 *   3. either way, every later bracket of either caller refuses.
 */
export class WorkingDirectory {
  private failure: string | undefined;

  /**
   * `stop`: what to do when not even `/` can be installed (exit the process). `openRoot`: how `/` is opened. A test
   * names its own of each.
   */
  constructor(
    private readonly stop: (reason: string) => never = stopTheProcess,
    private readonly openRoot: () => number = () => openSync('/', constants.O_RDONLY | constants.O_DIRECTORY),
  ) {}

  /** Why the working directory is no longer the runtime's own, or `undefined` while it is. */
  get broken(): string | undefined {
    return this.failure;
  }

  /**
   * Puts `home` back as the working directory with `fchdir`. On failure: records why, installs `/` instead, and — if
   * even that fails — stops. Returns whether `home` was restored. Never throws: it runs in a `finally`.
   */
  restore(fchdir: (fd: number) => number, home: number): boolean {
    if (fchdir(home) === 0) return true;
    this.failure = 'the working directory could not be restored after a folder step';
    let root: number;
    try {
      root = this.openRoot();
    } catch {
      return this.stop(`${this.failure}, and / could not be opened instead`);
    }
    try {
      if (fchdir(root) !== 0) this.stop(`${this.failure}, and / could not be installed instead`);
    } finally {
      closeSync(root);
    }
    return false;
  }
}

function stopTheProcess(reason: string): never {
  process.stderr.write(`${reason}: stopping rather than running on in a folder an agent can write\n`);
  process.exit(70);
}

/** The one this process's brackets share. */
export const PROCESS_WORKING_DIRECTORY = new WorkingDirectory();
