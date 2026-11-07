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
 * Where each stored credential digest was last seen, and the stamp that scan was made under.
 *
 * It is the lookup state of {@link CredentialAgentIdentities}, injected so that service holds none of
 * its own (docs/standards/stateless-oop-di). The map and the stamp live together because neither means
 * anything without the other: locations are only trusted while the stamp they were built under still
 * holds. Only digests are retained, at most one per fleet member; a null location marks a digest shared
 * by several sessions.
 */
export class CredentialDigestLocations {
  private readonly byDigest = new Map<string, string | null>();
  private scannedAt: string | undefined;

  /** The session last seen holding the digest, when the scan made under `stamp` is still current. */
  locate(digest: string, stamp: string): string | null | undefined {
    return this.scannedAt === stamp ? this.byDigest.get(digest) : undefined;
  }

  forget(digest: string): void {
    this.byDigest.delete(digest);
  }

  /** Replaces rather than accumulates, so the map is bounded by the fleet and never by requests. */
  replace(sessions: readonly CredentialedSession[], stamp: string): void {
    this.byDigest.clear();
    for (const candidate of sessions) {
      const stored = candidate.sessionCapabilityHash;
      this.byDigest.set(stored, this.byDigest.has(stored) ? null : candidate.id);
    }
    this.scannedAt = stamp;
  }

  entries(): readonly (readonly [string, string | null])[] {
    return [...this.byDigest];
  }
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
 * written — was written since that scan. The stamp is read BEFORE the scan and compared at use, and
 * the daemon's storage moves it only AFTER a configuration write has also been published to the
 * session index, so a scan that overlapped a half-published write (new document, member not yet
 * listed) is stamped with a value that has already moved and is never trusted. A moved stamp discards
 * every remembered location, so a rotation or a new session that makes a digest shared is seen before
 * it can be answered from a hint. Between stamps, the one session is re-read, so its own rotation,
 * stop or removal refuses at once.
 *
 * The guarantee is therefore: identical to a full scan for every change made through the daemon's
 * configuration writes and session-index publication. Acceptance never rests on the map: it always
 * needs a fresh single-session read that is ACTIVE and passes the constant-time compare, never a
 * cached yes. The map holds digests only and is bounded by the fleet.
 *
 * What the stamp cannot see is an out-of-band edit, copy or restore of a session's config.json that
 * gives an EARLIER session a digest another session already holds. Until the next configuration
 * write or scan, a warmed hit can keep answering with the session it remembered. That is safe: it
 * needs ownership of the machine's state home; the presented credential must still match a freshly
 * read, active session, so no wrong credential is admitted and a hint is no prefix oracle; and
 * today's full scan picks among duplicate holders by an arbitrary order of its own. It heals at the
 * next configuration write or scan.
 */
export class CredentialAgentIdentities implements AgentIdentityResolver {
  constructor(
    private readonly sessions: CredentialedSessions,
    private readonly hash: (capability: string) => string,
    private readonly matches: (left: string, right: string) => boolean,
    private readonly locations: CredentialDigestLocations,
    /** Moves whenever any session configuration is written and published: the signal that a stored hash may have changed. */
    private readonly stamp: () => string,
  ) {}

  async resolve(capability: string): Promise<AgentIdentity | undefined> {
    const digest = this.hash(capability);
    // Read BEFORE any document, so a write landing during a scan can only make the map look older.
    const stamp = this.stamp();
    const id = this.locations.locate(digest, stamp);
    let session: CredentialedSession | undefined;
    if (id !== undefined && id !== null) {
      const candidate = await this.sessions.session(id);
      if (candidate?.id === id && candidate.active && this.matches(candidate.sessionCapabilityHash, digest)) {
        session = candidate;
      } else {
        // Rotation, termination and removal invalidate the hint immediately; none can authenticate
        // from a remembered identity. A scan may still find another session holding this digest.
        this.locations.forget(digest);
      }
    }
    if (session === undefined) {
      const sessions = await this.sessions.snapshot();
      // Ambiguous digests always keep snapshot order (the first ACTIVE match), including when a
      // previously inactive holder is revived.
      this.locations.replace(sessions, stamp);
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
