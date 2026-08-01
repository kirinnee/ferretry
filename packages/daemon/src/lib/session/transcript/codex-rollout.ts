/**
 * Which Codex rollout belongs to a session — answered with proof, or not answered.
 *
 * Codex names its own session and takes no id from the launcher, so the daemon cannot decide the
 * filename the way it can for Claude. Two facts recorded at launch make an exact answer possible
 * anyway:
 *
 *   * THE BASELINE. Every rollout that already existed when this session launched belongs to
 *     somebody else, by construction. Excluding it costs nothing and removes the entire history of
 *     the account from consideration.
 *   * THE CORRELATION TOKEN. A string this daemon injected into this session and into no other —
 *     the session's own directory, which its opening turn tells the agent to read. A rollout
 *     containing it was written by this session; a rollout that does not is not this session's
 *     however recent it is.
 *
 * WHAT THIS DELIBERATELY REFUSES TO DO. The audit behind this unit named the shortcut and rejected
 * it: picking the newest rollout whose `cwd` matches. Concurrent teammates routinely share a
 * working directory and an account, so that rule attributes one agent's transcript to another
 * session — and the reader has no way to tell, because the wrong transcript parses perfectly. When
 * no candidate carries the token this returns `undefined` and the caller tries again later, which
 * is the correct answer while Codex has not yet flushed the injected path to disk.
 */

/** One rollout on disk, as the index describes it. */
export interface CodexRolloutCandidate {
  /** The harness's own session id, from the rollout's `session_meta`. */
  readonly id: string;
  readonly file: string;
  /** Whether the rollout's bytes contain the session's correlation token. */
  readonly correlated: boolean;
}

/** What is already known about the session asking. */
export interface CodexRolloutQuery {
  /** Rollout ids that existed before this session launched. */
  readonly baseline: readonly string[];
  /** Rollout ids other live sessions have already been attributed. */
  readonly claimed?: readonly string[];
}

/**
 * The rollout this session owns, or `undefined` when nothing proves ownership.
 *
 * An ambiguous answer is refused rather than resolved: two correlated candidates means the token
 * was not unique after all, and picking either would be the guess this whole module exists to
 * avoid.
 */
export function selectCodexRollout(
  candidates: readonly CodexRolloutCandidate[],
  query: CodexRolloutQuery,
): CodexRolloutCandidate | undefined {
  const excluded = new Set([...query.baseline, ...(query.claimed ?? [])]);
  const correlated = candidates.filter(candidate => candidate.correlated && !excluded.has(candidate.id));
  return correlated.length === 1 ? correlated[0] : undefined;
}
