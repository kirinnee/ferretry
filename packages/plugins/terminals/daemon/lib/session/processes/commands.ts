import type { SessionProcessOutputAvailability } from '../../protocol/session-processes.ts';
import type { ProcessStreamTarget } from './ports.ts';

/** WHERE A PROCESS'S OUTPUT CAN BE READ. Pure: no IO, no clock. The harness-wrapper reading (`commandLabel`) lives in `@ferretry/std`. */

/**
 * The Claude Code task id a shell's output file names (`…/tasks/<id>.output`), or `undefined`.
 *
 * Verified against Claude Code 2.1.x: EVERY Bash tool command — foreground and `run_in_background` —
 * has its stdout and stderr redirected to `/tmp/claude-<uid>/<project-slug>/<session-uuid>/tasks/<id>.output`.
 * A foreground command's file is deleted when the command returns; a background one's stays.
 */
export function claudeTaskId(path: string): string | undefined {
  return /\/tasks\/([A-Za-z0-9_-]{1,64})\.output$/u.exec(path)?.[1];
}

/** The file a process's output can be read from: stdout's if it is a regular file, else stderr's. */
export function outputFileOf(stdout?: ProcessStreamTarget, stderr?: ProcessStreamTarget): string | undefined {
  if (stdout?.kind === 'file') return stdout.path;
  if (stderr?.kind === 'file') return stderr.path;
  return undefined;
}

/** Where this live process's output can be read, or why it cannot — in words a person can act on. */
export function liveOutputAvailability(
  stdout: ProcessStreamTarget | undefined,
  stderr: ProcessStreamTarget | undefined,
): SessionProcessOutputAvailability {
  if (outputFileOf(stdout, stderr) !== undefined) return { source: 'file' };
  const target = stdout ?? stderr;
  if (target === undefined) return { source: 'none', reason: 'Reading output is not supported on macOS yet.' };
  switch (target.kind) {
    case 'terminal':
      return { source: 'none', reason: 'Writes to the terminal — see Console.' };
    case 'pipe':
    case 'socket':
      // A Codex command's pipe is Codex's own: its result reaches Chat (and this tab) when it ends.
      return {
        source: 'none',
        reason: 'Its output goes straight to another program (often the agent); reading it here would take it away.',
      };
    case 'null':
      return { source: 'none', reason: 'Its output is thrown away (sent to /dev/null).' };
    default:
      return { source: 'none', reason: 'Its output goes somewhere that cannot be read safely.' };
  }
}

/** Cuts a command line to `max` UTF-16 code units, saying whether it did. */
export function truncateCommand(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max - 1)}…`, truncated: true };
}
