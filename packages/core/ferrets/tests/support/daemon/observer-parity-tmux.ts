/**
 * Real tmux for the observer's parity scenarios: a throwaway server on a private socket, a command that runs in it,
 * and the plain `tmux` reads a session worker is allowed. Used only by integration tests that need a real pane
 * (CI only) — the observer's own pacing and decisions are covered against scripted panes elsewhere.
 */
import type { TmuxCommandPort, TmuxCommandResult } from '../../../daemon/lib/session/peers/tmux.ts';

/** A tmux command port over the `tmux` binary on `socket`. */
export function tmuxPort(executable: string, socket: string): TmuxCommandPort {
  return {
    execute: async (arguments_, stdin): Promise<TmuxCommandResult> => {
      const child = Bun.spawn([executable, '-u', '-S', socket, ...arguments_], {
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}

/** What a parity scenario asks of its pane: run a command in a new session, and read the visible screen. */
export interface ParityTmux {
  launch(spec: {
    readonly session: string;
    readonly cwd: string;
    readonly command: readonly [string, ...string[]];
    readonly width?: number;
    readonly height?: number;
  }): Promise<void>;
  visible(session: string): Promise<string | undefined>;
}

export function parityTmux(executable: string, socket: string): ParityTmux {
  const port = tmuxPort(executable, socket);
  return {
    launch: async spec => {
      const made = await port.execute([
        'new-session',
        '-d',
        '-s',
        spec.session,
        '-x',
        String(spec.width ?? 80),
        '-y',
        String(spec.height ?? 24),
        '-c',
        spec.cwd,
        ...spec.command,
      ]);
      if (made.code !== 0) throw new Error(`tmux could not start ${spec.session}: ${made.stderr.trim()}`);
    },
    visible: async session => {
      const captured = await port.execute(['capture-pane', '-p', '-t', session]);
      return captured.code === 0 ? captured.stdout : undefined;
    },
  };
}
