import type { TerminalKey } from '../../../contract/index.ts';
import type { SurfaceKind } from '../protocol/surface-control.ts';

/**
 * The pure decisions of the terminal tools (today's `lib/agent-tools/policy.ts`, the terminal part): the bytes a
 * named key is, which foreground programs mean "the command has ended", how output is clipped, and how a terminal is
 * written in a sentence.
 */

/** The longest output one answer carries (today's `AGENT_TOOL_MAX_OUTPUT_CHARS`). */
export const AGENT_TOOL_MAX_OUTPUT_CHARS = 65_536;

/** The bytes each named key sends — what a terminal receives when the key is pressed. */
export const TERMINAL_KEY_BYTES: Readonly<Record<TerminalKey, string>> = {
  enter: '\r',
  tab: '\t',
  escape: '\u001b',
  backspace: '\u007f',
  delete: '\u001b[3~',
  space: ' ',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  home: '\u001b[H',
  end: '\u001b[F',
  'page-up': '\u001b[5~',
  'page-down': '\u001b[6~',
  'ctrl-a': '\u0001',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'ctrl-e': '\u0005',
  'ctrl-k': '\u000b',
  'ctrl-l': '\u000c',
  'ctrl-r': '\u0012',
  'ctrl-u': '\u0015',
  'ctrl-w': '\u0017',
  'ctrl-z': '\u001a',
};

/** Text, then keys, as the bytes a terminal receives. */
export function terminalInput(text: string | undefined, keys: readonly TerminalKey[] = []): Uint8Array {
  return new TextEncoder().encode(`${text ?? ''}${keys.map(key => TERMINAL_KEY_BYTES[key]).join('')}`);
}

/**
 * The programs that mean "nothing is running": the shell a terminal opens with, and the ones a person
 * commonly starts inside it. A wait for `exit` ends when one of these is back in the foreground.
 */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'dash', 'bash', 'zsh', 'fish', 'ksh', 'mksh', 'ash', 'tcsh', 'csh']);

export function isShellForeground(command: string): boolean {
  return SHELLS.has(command.replace(/^-/u, ''));
}

/** Keeps the newest output, which is what a reader of a terminal or page wants, inside the wire bound. */
export function clipOutput(text: string, limit: number = AGENT_TOOL_MAX_OUTPUT_CHARS): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** A surface as a person writes it: `%terminal:dev`. */
export function surfaceReference(surface: SurfaceKind, key: string): string {
  return `%${surface}:${key}`;
}
