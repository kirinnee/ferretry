import { bunSpawn } from '@ferretry/kernel/host';
import { programRunner } from '../../../../daemon/adapters/terminal/system-login-shell.ts';
import type {
  ControlChild,
  ControlModeOptions,
  ControlTimer,
} from '../../../../daemon/adapters/tmux/control-tmux-process.ts';
import { KernelTmuxProcess } from '../../../../daemon/adapters/tmux/kernel-tmux-process.ts';

/**
 * The host's own spawn port for integration tests (CI only: they run the real tmux), standing in for the kernel's
 * `kernel.spawn` the daemon hands Terminals.
 */
export const hostSpawn = bunSpawn(process.env as Record<string, string>);

/** One tmux command per process, over the host spawn port (today's `BunTmuxProcess`). */
export class BunTmuxProcess extends KernelTmuxProcess {
  constructor(executable: string, socket: string) {
    super(hostSpawn, socket, executable);
  }
}

/** A program run with argv through the host spawn port; its stdout, or nothing on a failure. */
export const runProgram = programRunner(hostSpawn);

/** Real timers, as the kernel's clock gives them. */
export const realAfter: ControlTimer = (milliseconds, fn) => {
  const handle = setTimeout(fn, milliseconds);
  return () => clearTimeout(handle);
};

/** A long-lived control client started with `Bun.spawn`, as the kernel's `spawn.start` starts one. */
function spawnControlChild(argv: readonly string[]): ControlChild {
  const child = Bun.spawn([...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  return {
    stdin: { write: text => child.stdin.write(text), flush: () => child.stdin.flush() },
    stdout: child.stdout,
    exited: child.exited,
    kill: signal => child.kill(signal),
  };
}

/** Control-mode options with the required clock, timers and spawn filled in from the host; `extra` wins. */
export function controlOptions(extra: Partial<ControlModeOptions> = {}): ControlModeOptions {
  return { nowMs: () => Date.now(), after: realAfter, spawn: spawnControlChild, ...extra };
}
