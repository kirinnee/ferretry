import type { ChildHandle, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';

/**
 * A real `Bun.spawn` behind the kernel's `SpawnPort.start` shape, for tests that run a real child (tests may use `Bun.spawn`).
 * `extraEnv` is for a test box only: the daemon's real spawn port is SEALED and adds nothing, so a native library needs
 * its C++ runtime where the loader looks (a normal distribution has it; a bare Nix shell does not, and a test names it here).
 */
export function processSpawn(
  record: { pids: number[] } = { pids: [] },
  extraEnv: Readonly<Record<string, string>> = {},
): Pick<SpawnPort, 'start'> & { pids: number[] } {
  return {
    pids: record.pids,
    start: (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
      const child = Bun.spawn([program, ...args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', ...extraEnv, ...(options?.env as Record<string, string> | undefined) },
      });
      record.pids.push(child.pid);
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        write: chunk => {
          child.stdin.write(chunk);
          child.stdin.flush();
        },
        kill: signal => child.kill(signal as NodeJS.Signals | undefined),
        exited: child.exited,
        pipes: [],
        closePipes: () => undefined,
      };
    },
  };
}
