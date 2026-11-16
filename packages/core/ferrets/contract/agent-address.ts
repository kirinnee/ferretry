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

/** A callsign a reference may spell, and the id shape a reference may carry. Anything else proves nothing. */
const REFERENCE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const REFERENCE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** What a `:agent` reference was proved to address: the ferret and the name it is shown by. */
export interface ProvedAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * PROOF FOR A `:agent` REFERENCE against ONE daemon's fleet (docs/reference-standard.md: syntax is never proof).
 *
 * A ferret takes part only with a well-formed callsign and a safe id. An exact id proves that ferret; a name follows
 * {@link resolveAgentAddress} — the rule the daemon applies to `fy send <name>` — so a name two ferrets hold on the same
 * footing proves NOTHING and stays prose. The caller stamps its daemon on the answer: this knows no daemon.
 */
export const provedAgentReference = (
  lookup: { readonly sessionId?: string | undefined; readonly name?: string | undefined },
  fleet: readonly AgentAddressCandidate[],
): ProvedAgent | null => {
  const named = new Map<string, ProvedAgent>();
  const candidates: AgentAddressCandidate[] = [];
  for (const candidate of fleet) {
    const name = candidate.name?.trim().toLowerCase();
    if (name === undefined || !REFERENCE_NAME.test(name) || !REFERENCE_SESSION_ID.test(candidate.id)) continue;
    if (candidate.id === '.' || candidate.id === '..') continue;
    named.set(candidate.id, { id: candidate.id, name });
    candidates.push({ ...candidate, name });
  }
  if (lookup.sessionId !== undefined) return named.get(lookup.sessionId) ?? null;
  const name = lookup.name?.trim().toLowerCase();
  if (name === undefined || !REFERENCE_NAME.test(name)) return null;
  const resolution = resolveAgentAddress(name, candidates);
  return resolution.kind === 'session' ? (named.get(resolution.id) ?? null) : null;
};
