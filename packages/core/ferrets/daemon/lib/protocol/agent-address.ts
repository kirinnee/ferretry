/**
 * Which session an AGENT NAME addresses — the one rule every surface that takes a session id applies.
 *
 * Agents are named with auto-generated first names (`aniya`, `torrey`), unique per machine among the
 * sessions that hold them, and a name is meant to work as an address everywhere a session id does:
 * `fy send aniya …`, every `/v1/sessions/:sessionId/…` route, and the `:aniya` reference a person types
 * in the composer. Before this module the daemon's send route accepted only ids, its signal and sender
 * lookups used a five-day "newest holder wins" window, the command line resolved names for `rename`
 * alone, and the app ran its own copy of the window — four answers to one question, and the one an
 * agent actually used (`fy send <name>`) answered "no session".
 *
 * SINGLE-SOURCED HERE because the daemon, the command line and the app may not import one another,
 * and the protocol package is the one thing all of them already depend on.
 *
 * THE RULE.
 *
 *   1. An exact session id is that session, whatever names exist.
 *   2. Otherwise the reference is a name — case-insensitive, with an optional leading `:` so the
 *      composer's `:aniya` can be pasted as-is.
 *   3. A LIVE holder wins over a dormant one: a revived session that kept an old name, or a finished
 *      agent whose name a newer one has since taken, must not steal messages from the agent that is
 *      actually running.
 *   4. Two holders on the same footing are REFUSED, with the candidates, rather than guessed between.
 *      A message delivered to the wrong agent is worse than one that asks its sender to pick.
 */

/** One session a name could address. */
export interface AgentAddressCandidate {
  readonly id: string;
  /** The session's agent name (`teammate`), in whatever case it was stored. */
  readonly name?: string | undefined;
  /** Its status, when known. A missing status reads as dormant, never as live. */
  readonly status?: string | undefined;
}

/** What a reference turned out to address. */
export type AgentAddressResolution =
  | { readonly kind: 'session'; readonly id: string }
  | {
      readonly kind: 'ambiguous';
      /** The name as it was matched: lowercase, without the `:`. */
      readonly name: string;
      readonly candidates: readonly AgentAddressCandidate[];
    }
  | { readonly kind: 'unknown' };

/**
 * Statuses in which a session is not running an agent at all. Everything else — including a parked,
 * stalled or rate-limited one — is an agent that can be talked to.
 */
export const DORMANT_AGENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'kill_failed']);

/** Whether a candidate is running an agent now. */
export const isLiveAgentCandidate = (candidate: AgentAddressCandidate): boolean =>
  candidate.status !== undefined && !DORMANT_AGENT_STATUSES.has(candidate.status);

/** The name a reference spells: trimmed, lowercase, the composer's `:` dropped. */
export const agentAddressName = (reference: string): string => reference.trim().replace(/^:/u, '').toLowerCase();

/** Resolves an id-or-name reference against this machine's sessions. */
export function resolveAgentAddress(
  reference: string,
  candidates: readonly AgentAddressCandidate[],
): AgentAddressResolution {
  const exact = reference.trim();
  if (exact !== '' && candidates.some(candidate => candidate.id === exact)) return { kind: 'session', id: exact };
  const name = agentAddressName(reference);
  if (name === '') return { kind: 'unknown' };
  const holders = candidates.filter(candidate => candidate.name?.trim().toLowerCase() === name);
  const live = holders.filter(isLiveAgentCandidate);
  const pool = live.length > 0 ? live : holders;
  const [only] = pool;
  if (only === undefined) return { kind: 'unknown' };
  if (pool.length === 1) return { kind: 'session', id: only.id };
  return { kind: 'ambiguous', name, candidates: pool };
}

/**
 * The refusal for an ambiguous name, naming every candidate so the sender can choose by id.
 *
 * Shared so the daemon's answer and anything that repeats it read the same sentence.
 */
export function ambiguousAgentAddressMessage(name: string, candidates: readonly AgentAddressCandidate[]): string {
  const listed = candidates.map(candidate => `${candidate.id} (${candidate.status ?? 'status unknown'})`).join(', ');
  return `the name ${name} is held by ${candidates.length} sessions on this machine: ${listed}; address one by its session id`;
}
