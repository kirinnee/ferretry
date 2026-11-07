import { displaySystemCallsign, isSystemCallsign } from '@ferretry/protocol';
import { formatSessionTitle, normalizeCallsign } from './policy.ts';
import {
  CALLSIGN_WINDOW_MS,
  type NameAllocationError,
  type NameAllocationErrorCode,
  type NameAllocationRequest,
  type NameAllocationResult,
  type NameClaim,
} from './types.ts';

/**
 * AGENT NAMES: every agent on this machine answers to a first name nobody else here is using.
 *
 * The name is the session's `teammate` callsign — stored lowercase, shown title-cased (`hadi` →
 * `Hadi`) — and it is the one fact the agent list, the header, the picker, the chips and the
 * notifications all read. A start that names nobody is given one from the pool, the way kteam does;
 * a start that names somebody claims exactly that name; and a rename claims the new one through the
 * same allocator, so all three paths obey one uniqueness rule.
 *
 * WHEN A NAME IS HELD, AND WHEN IT IS FREE AGAIN — the re-use policy, decided here:
 *
 *   * A session that has not ENDED holds its name for as long as it exists, however old it is. Two
 *     live agents can never share a first name.
 *   * An ended session (completed, failed, stalled, stopped) keeps its name for the resolution window
 *     after it last changed, so a bare `hadi` typed today still means the agent that finished
 *     yesterday. After that the name goes back into the pool.
 *   * A deleted session holds nothing: its documents are gone, and so is its claim on a name.
 *
 * DECLARED GAP: reviving an ended session older than the window does not re-claim its name, so the
 * revived agent can share a first name with a newer one. Its id still tells them apart, and renaming
 * either resolves it.
 */

/** The statuses after which a session is no longer running and its name may age out. */
const ENDED_SESSION_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/** A live session's hold has no expiry; this is the largest instant the claim ledger can represent. */
const HELD_WHILE_LIVE_MS = Number.MAX_SAFE_INTEGER;

/** What a stored session says about the name it answers to. */
export interface StoredSessionName {
  readonly id: string;
  readonly teammate?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}

/**
 * The claim a stored session holds on its name, or nothing when it holds none.
 *
 * A session with no name, an unreadable creation instant, or a teammate that is not a well-formed
 * callsign contributes NOTHING rather than a guess: over-reporting a name as taken quietly shrinks the
 * pool, and that failure is invisible.
 */
export function sessionNameClaim(session: StoredSessionName, windowMs = CALLSIGN_WINDOW_MS): NameClaim | undefined {
  const callsign = normalizeCallsign(session.teammate ?? '');
  const claimedAtMs = Date.parse(session.createdAt ?? '');
  if (callsign === null || !Number.isFinite(claimedAtMs)) return undefined;
  if (session.status === undefined || !ENDED_SESSION_STATUSES.has(session.status))
    return { callsign, ownerId: session.id, claimedAtMs, expiresAtMs: HELD_WHILE_LIVE_MS };
  const updatedAtMs = Date.parse(session.updatedAt ?? '');
  const lastMovedMs = Number.isFinite(updatedAtMs) ? Math.max(claimedAtMs, updatedAtMs) : claimedAtMs;
  return { callsign, ownerId: session.id, claimedAtMs, expiresAtMs: lastMovedMs + windowMs };
}

/** Taking a name, and giving one back — the allocator decides, the ledger persists. */
export interface SessionNameClaims {
  allocate(request: NameAllocationRequest): Promise<NameAllocationResult>;
  release(callsign: string, ownerId: string): Promise<void>;
}

/** What a start asked for: a name, whether a taken one may fall back, or nothing at all. */
export interface StartNameRequest {
  readonly teammate?: string;
  readonly teammateFallback?: boolean;
}

/** The name a start will answer to, or the refusal a REQUESTED name earned. */
export type StartNameOutcome =
  | { readonly ok: true; readonly callsign?: string }
  | { readonly ok: false; readonly error: NameAllocationError };

/**
 * The name a new session answers to, CLAIMED before its document exists.
 *
 * A REQUESTED name is the caller's decision, so a refusal is the caller's to hear: a taken name is
 * refused unless the caller allowed a fallback. An AUTOMATIC name is the daemon's convenience, so it
 * never costs the caller a session: an exhausted pool or an unreadable ledger starts the agent
 * unnamed rather than not at all. An unnamed session breaks no uniqueness — it answers to its id.
 */
export async function claimStartName(
  claims: SessionNameClaims,
  ownerId: string,
  request: StartNameRequest,
  nowMs: number,
): Promise<StartNameOutcome> {
  if (request.teammate === undefined) {
    const automatic = await claims.allocate({ ownerId, nowMs });
    return automatic.ok ? { ok: true, callsign: automatic.claim.callsign } : { ok: true };
  }
  const requested = await claims.allocate({
    ownerId,
    nowMs,
    requested: request.teammate,
    ...(request.teammateFallback === true ? { fallback: true } : {}),
  });
  return requested.ok ? { ok: true, callsign: requested.claim.callsign } : { ok: false, error: requested.error };
}

/**
 * Title-case a callsign for display: `hadi` → `Hadi`, `mary-jane` → `Mary-Jane`. A system callsign
 * is no first name and keeps its own shape: `warden-00002a` → `warden-00002A`.
 */
export function displayAgentName(callsign: string): string {
  if (isSystemCallsign(callsign)) return displaySystemCallsign(callsign);
  return callsign
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

/**
 * What an agent is called in a sentence a person reads — a notification title, an alert.
 *
 * Its first name when it has one, because that is what every other surface calls it; its task title
 * otherwise, which is all an unnamed session has.
 */
export function agentSpokenName(session: { readonly teammate?: string; readonly name: string }): string {
  const callsign = normalizeCallsign(session.teammate ?? '');
  return callsign === null ? session.name : displayAgentName(callsign);
}

// ─── rename ──────────────────────────────────────────────────────────────────────────────────────

/** The two names a session carries: its first name and its task title. */
export interface SessionNames {
  readonly teammate?: string;
  readonly name: string;
}

/** A rename as the boundary parsed it. */
export interface SessionRenameRequest {
  readonly teammate?: string;
  readonly name?: string;
  readonly clearParent?: boolean;
}

/** Why a rename was refused. */
export type SessionRenameFailure =
  /** The request is well formed and still describes nothing usable — a title of control characters. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** Another agent on this machine already answers to that name. */
  | 'taken'
  /** The request asks for something a rename does not do. */
  | 'unsupported'
  /** The name ledger could not be read or written, so no name can be claimed safely. */
  | 'unavailable'
  /** The rename was decided and could not be written. */
  | 'failed';

/** A refusal in a taxonomy the mount restates over HTTP. */
export class SessionRenameError extends Error {
  constructor(
    readonly failure: SessionRenameFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionRenameError';
  }
}

/** The journal entry a rename leaves on the session it renamed: who, and from what to what. */
export interface SessionRenamedEntry {
  readonly actor: string;
  readonly from: SessionNames;
  readonly to: SessionNames;
}

export interface SessionRenamePorts {
  /** The session's current names, or `undefined` when there is no such session. */
  current(sessionId: string): Promise<SessionNames | undefined>;
  /** Writes both names onto the session's configuration, stamped with `at`. */
  write(sessionId: string, next: SessionNames, at: string): Promise<void>;
  /** Appends the `session.renamed` entry to the session's own journal. */
  journal(sessionId: string, entry: SessionRenamedEntry): Promise<void>;
  readonly claims: SessionNameClaims;
  now(): Date;
}

/** How each allocation refusal reads as a rename refusal. A requested name never falls back, so an
 *  exhausted pool and a failed random draw are answered as the internal faults they would be. */
const RENAME_REFUSALS: Readonly<Record<NameAllocationErrorCode, SessionRenameFailure>> = {
  invalid_callsign: 'invalid',
  callsign_taken: 'taken',
  pool_exhausted: 'failed',
  claim_store_failed: 'unavailable',
  random_source_failed: 'failed',
};

/**
 * Keeps a `[Hadi] Task` title in step with the first name it was composed from.
 *
 * Only a bracket that names the OLD first name is rewritten — a title the person wrote some other way
 * is theirs, and is left exactly as it is.
 */
function retitled(name: string, from: string | undefined, to: string): string {
  if (from === undefined) return name;
  const prefix = `[${displayAgentName(from)}]`;
  return name.toLowerCase().startsWith(prefix.toLowerCase())
    ? `[${displayAgentName(to)}]${name.slice(prefix.length)}`
    : name;
}

/**
 * Renaming an agent: `POST /v1/sessions/:sessionId/rename`.
 *
 * THE NEW FIRST NAME IS CLAIMED, NOT WRITTEN. It goes through the same allocator a start uses, so a
 * name another agent holds is refused in plain words, and a rename racing a start for one name loses
 * or wins atomically on the ledger. Renaming to the name the agent already has is a no-op claim.
 *
 * WHO MAY RENAME. Anyone who may operate the session — the person, from the CLI or a paired browser,
 * and an agent renaming itself. Refusing an agent here would be theatre: the in-pane attribution is a
 * header the agent controls, so the only effect of refusing `peer:` callers would be to make an agent
 * omit it. A name is a label, not an authority; every rename is journalled with its actor.
 *
 * DETACHING FROM A PARENT IS REFUSED. `clearParent` is on the wire because a client composed it, but
 * the parent edge is what the warden's lineage backstop and the cgroup exemption walk; letting a
 * rename rewrite it would let a session leave its supervision by changing its name.
 */
export class SessionRenameService {
  constructor(private readonly ports: SessionRenamePorts) {}

  async rename(sessionId: string, request: SessionRenameRequest, actor: string): Promise<void> {
    if (request.clearParent === true)
      throw new SessionRenameError('unsupported', 'a rename cannot detach a session from its parent');
    const from = await this.ports.current(sessionId);
    if (from === undefined) throw new SessionRenameError('not_found', `no session ${sessionId}`);
    const title = request.name === undefined ? from.name : formatSessionTitle(request.name);
    if (title === '') throw new SessionRenameError('invalid', 'a task title must contain printable text');
    const now = this.ports.now();
    const claimed = await this.claim(sessionId, from.teammate, request.teammate, now.getTime());
    const to: SessionNames = {
      ...(claimed === undefined ? {} : { teammate: claimed }),
      name: request.name === undefined && claimed !== undefined ? retitled(title, from.teammate, claimed) : title,
    };
    try {
      await this.ports.write(sessionId, to, now.toISOString());
    } catch (error) {
      // The reservation was taken for a rename that never landed; holding it would park the name.
      if (claimed !== undefined && claimed !== from.teammate)
        await this.ports.claims.release(claimed, sessionId).catch(() => undefined);
      throw new SessionRenameError('failed', error instanceof Error ? error.message : String(error));
    }
    await this.ports.journal(sessionId, { actor, from, to });
  }

  /** The first name the session will answer to after this rename. */
  private async claim(
    sessionId: string,
    current: string | undefined,
    requested: string | undefined,
    nowMs: number,
  ): Promise<string | undefined> {
    if (requested === undefined) return current;
    if (current !== undefined && normalizeCallsign(requested) === normalizeCallsign(current)) return current;
    const allocated = await this.ports.claims.allocate({ ownerId: sessionId, nowMs, requested });
    if (allocated.ok) return allocated.claim.callsign;
    const failure = RENAME_REFUSALS[allocated.error.code];
    throw new SessionRenameError(
      failure,
      failure === 'taken'
        ? `another agent on this machine is already called ${displayAgentName(normalizeCallsign(requested) ?? requested)} — choose a different name`
        : allocated.error.message,
    );
  }
}
