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
  scripts: 'Page scripts',
};

/** The plain sentence an agent is told when the machine's settings switch a kind of control off. */
export function controlRefusal(kind: AgentControlKind): string {
  const setting = CONTROL_SETTING[kind];
  // Lower-cased as a phrase, except a name that is a name: Ferretry settings.
  const phrase = setting.startsWith('Ferretry') ? setting : setting.toLowerCase();
  return `This machine does not let agents control ${phrase}: "What agents may control › ${setting}" is off in this machine's settings. Ask the person to turn it on if you need it.`;
}

/**
 * What an agent is told when it asks for `browser.eval` and the owner has not turned Page scripts on:
 * that only the owner can, every way they can, and why it waits for them. The other browser tools need
 * no switch, so the agent is pointed back at them.
 */
export function pageScriptsRefusal(binaryName: string): string {
  return `browser.eval is off on this machine: "What agents may control › Page scripts" is off, and only the owner can turn it on — in the app (Settings › this machine › What agents may control › Page scripts), with \`${binaryName} machine set agent-control scripts on\`, or with agentControl.pageScripts: true in machine.yaml. Turning it on waits for their confirmation, because a page script can read what a page holds, sign-ins on the shared profile included. Ask them if you need it; the other browser tools work without it.`;
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

/** The same credential projection, for a fleet scan or a fresh proof of one cached session. */
export interface CredentialedSessions {
  snapshot(): Promise<readonly CredentialedSession[]>;
  session(id: string): Promise<CredentialedSession | undefined>;
}

/**
 * Finds the live session a presented credential was minted for.
 *
 * Only digests are retained. A digest locates a candidate; its freshly read hash still has to match
 * in constant time, and its current state must be active. A stopped session's credential proves
 * nothing: the session it named is not there to act for. A miss scans the fleet as before.
 *
 * ## THE ANSWER NEVER DEPENDS ON CACHE HISTORY
 *
 * The answer is the first ACTIVE session, in snapshot order, whose stored hash matches. A remembered
 * location is therefore only trusted while it is provably the ONLY session that holds the digest:
 * the scan that built the map recorded a digest shared by several sessions as ambiguous, which always
 * scans, and `stamp` says whether any session configuration — the only place a stored hash is
 * written — was written since that scan. A moved stamp discards every remembered location, so a
 * rotation or a new session that makes a digest shared is seen before it can be answered from a hint.
 * Between stamps, the one session is re-read, so its own rotation, stop or removal refuses at once.
 *
 * The one thing the stamp cannot see is a configuration edited by hand, outside this daemon. That
 * can only change the answer when it plants a digest another session already holds, which a
 * credential's random 256-bit digest never does by itself; the next scan reads it.
 */
export class CredentialAgentIdentities implements AgentIdentityResolver {
  /** The stamp the map was built under; absent until the first scan, so nothing is trusted before one. */
  private scannedAt: string | undefined;

  constructor(
    private readonly sessions: CredentialedSessions,
    private readonly hash: (capability: string) => string,
    private readonly matches: (left: string, right: string) => boolean,
    /** Injected lookup state: a null id marks a digest shared by multiple sessions. */
    private readonly byDigest: Map<string, string | null>,
    /** Moves whenever any session configuration is written: the signal that a stored hash may have changed. */
    private readonly stamp: () => string,
  ) {}

  async resolve(capability: string): Promise<AgentIdentity | undefined> {
    const digest = this.hash(capability);
    // Read BEFORE any document, so a write landing during a scan can only make the map look older.
    const stamp = this.stamp();
    const id = this.scannedAt === stamp ? this.byDigest.get(digest) : undefined;
    let session: CredentialedSession | undefined;
    if (id !== undefined && id !== null) {
      const candidate = await this.sessions.session(id);
      if (candidate?.id === id && candidate.active && this.matches(candidate.sessionCapabilityHash, digest)) {
        session = candidate;
      } else {
        // Rotation, termination and removal invalidate the hint immediately; none can authenticate
        // from a remembered identity. A scan may still find another session holding this digest.
        this.byDigest.delete(digest);
      }
    }
    if (session === undefined) {
      const sessions = await this.sessions.snapshot();
      // Replace rather than accumulate: at most one digest per fleet member is retained, and a
      // stream of bogus credentials adds no entries. Ambiguous digests always keep snapshot order
      // (the first ACTIVE match), including when a previously inactive holder is revived.
      this.byDigest.clear();
      for (const candidate of sessions) {
        const stored = candidate.sessionCapabilityHash;
        this.byDigest.set(stored, this.byDigest.has(stored) ? null : candidate.id);
      }
      this.scannedAt = stamp;
      session = sessions.find(candidate => candidate.active && this.matches(candidate.sessionCapabilityHash, digest));
    }
    if (session === undefined) return undefined;
    if (session.name === null) return { sessionId: session.id };
    const teammate = session.teammate ?? undefined;
    return {
      sessionId: session.id,
      name: agentSpokenName({ name: session.name, ...(teammate === undefined ? {} : { teammate }) }),
    };
  }
}
