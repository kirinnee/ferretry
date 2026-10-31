import { AGENT_TOOL_MAX_OUTPUT_CHARS, type SurfaceKind, type TerminalKey } from '@ferretry/protocol';
import type { AgentControlKind } from '../fleet/agent-control.ts';
import { agentSpokenName } from '../names/session-names.ts';
import type { AgentIdentity, AgentIdentityResolver } from './types.ts';

/**
 * The pure decisions of the agent-tools domain: the bytes a named key is, which foreground programs
 * mean "the command has ended", how output is clipped, how a surface is written in a sentence, and
 * how a presented credential becomes a session.
 */

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

/**
 * Keeps the START of a page's accessibility tree or snapshot, inside the wire bound, on a line boundary.
 * A tree is read top-down — its first lines are the page's landmarks and headings — so the tail a
 * terminal keeps would hand back the footer.
 */
export function clipReading(text: string, limit: number = AGENT_TOOL_MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastLine = head.lastIndexOf('\n');
  return lastLine > 0 ? head.slice(0, lastLine) : head;
}

/** A surface as a person writes it: `%terminal:dev`. */
export function surfaceReference(surface: SurfaceKind, key: string): string {
  return `%${surface}:${key}`;
}

/** A selector short enough for an audit detail field, which holds 160 characters. */
export function auditSelector(selector: string): string {
  return selector.length <= 120 ? selector : `${selector.slice(0, 117)}...`;
}

/** The host a URL names — what the audit records instead of a URL that may carry a token. */
export function auditHost(url: string): string {
  return new URL(url).host;
}

const CONTROL_SETTING: Readonly<Record<AgentControlKind, string>> = {
  terminal: 'Terminals',
  browser: 'Browsers',
  files: 'Files',
  settings: 'Ferretry settings',
};

/** The plain sentence an agent is told when the machine's settings switch a kind of control off. */
export function controlRefusal(kind: AgentControlKind): string {
  const setting = CONTROL_SETTING[kind];
  // Lower-cased as a phrase, except a name that is a name: Ferretry settings.
  const phrase = setting.startsWith('Ferretry') ? setting : setting.toLowerCase();
  return `This machine does not let agents control ${phrase}: "What agents may control › ${setting}" is off in this machine's settings. Ask the person to turn it on if you need it.`;
}

/** A session as the identity resolver needs it — the task-board directory's projection satisfies it. */
export interface CredentialedSession {
  readonly id: string;
  readonly name: string | null;
  /** The agent's first name, when it has one — what a person calls it. */
  readonly teammate?: string | null;
  readonly active: boolean;
  readonly sessionCapabilityHash: string;
}

/**
 * Finds the live session a presented credential was minted for.
 *
 * The credential is hashed and compared with every live session's stored hash in constant time, so
 * the daemon never holds a plaintext credential and leaks no prefix to a caller who can time it. A
 * stopped session's credential proves nothing: the session it named is not there to act for.
 */
export class CredentialAgentIdentities implements AgentIdentityResolver {
  constructor(
    private readonly sessions: { snapshot(): Promise<readonly CredentialedSession[]> },
    private readonly hash: (capability: string) => string,
    private readonly matches: (left: string, right: string) => boolean,
  ) {}

  async resolve(capability: string): Promise<AgentIdentity | undefined> {
    const digest = this.hash(capability);
    const sessions = await this.sessions.snapshot();
    const session = sessions.find(
      candidate => candidate.active && this.matches(candidate.sessionCapabilityHash, digest),
    );
    if (session === undefined) return undefined;
    if (session.name === null) return { sessionId: session.id };
    const teammate = session.teammate ?? undefined;
    return {
      sessionId: session.id,
      name: agentSpokenName({ name: session.name, ...(teammate === undefined ? {} : { teammate }) }),
    };
  }
}
