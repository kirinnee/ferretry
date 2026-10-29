import type { SessionProcessOutputAvailability } from '@ferretry/protocol';
import type { ProcessStreamTarget } from './ports.ts';

/**
 * WHAT A COMMAND LINE SAYS, AND WHERE ITS OUTPUT CAN BE READ. Pure: no IO, no clock.
 *
 * Both harnesses run a tool command through a shell of their own, so the kernel's command line is the
 * wrapper, not what the agent asked for:
 *
 * - Claude Code: `zsh -c source <snapshot> … && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-…-cwd`
 * - Codex: `bash -lc <command>`
 *
 * {@link commandLabel} recovers the command the agent wrote, for the row's title; the wrapper stays in
 * `command`, unedited, because the brief is that argv is shown as it is.
 */

const CLAUDE_EVAL = /\beval '((?:[^']|'"'"'|'\\'')*)'(?: < \/dev\/null)? && pwd -P >\| \S*claude-[0-9a-f]+-cwd\s*$/su;
const SHELL_DASH_C = /^(?:\S*\/)?-?(?:bash|zsh|sh|dash|ksh|fish) (?:-[a-zA-Z]*c) (.+)$/su;

/** The command the agent asked for, when `argv` is a harness's wrapper around it; otherwise `undefined`. */
export function commandLabel(argv: string): string | undefined {
  const claude = CLAUDE_EVAL.exec(argv);
  if (claude?.[1] !== undefined) {
    const command = claude[1].replaceAll(`'"'"'`, `'`).replaceAll(`'\\''`, `'`).trim();
    return command === '' || command === argv ? undefined : command;
  }
  const shell = SHELL_DASH_C.exec(argv);
  const command = shell?.[1]?.trim();
  return command === undefined || command === '' || command === argv ? undefined : command;
}

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
