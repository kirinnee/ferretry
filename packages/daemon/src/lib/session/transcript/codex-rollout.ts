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
 *     the session's own directory, which every Codex launch declares as a workspace root
 *     ({@link codexCorrelationArguments}) so Codex writes it into the rollout itself. A rollout
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

/**
 * The folder, inside a session's own directory, that every Codex launch DECLARES and nothing creates.
 *
 * WHY THE TOKEN HAS TO BE PUT THERE RATHER THAN HOPED FOR. The correlation token used to reach a
 * rollout only as conversation content — the turn-file pointer a long send types, which names the
 * session's directory. A session started bare and spoken to in single lines ("hello") is typed
 * DIRECTLY, so its rollout never contained the token and its transcript could never be proven: Chat
 * stayed empty and every send went unconfirmed, while the pane showed Codex answering.
 *
 * `--add-dir` makes Codex write the path into the rollout itself, before the first turn, whatever the
 * person types: in `session_meta.runtime_workspace_roots` from 0.156, and in the opening
 * `environment_context` and each `turn_context.workspace_roots` in 0.145 (both measured against the
 * real binaries; the fixtures under `tests/fixtures/transcript/codex-rollouts/` are those runs).
 *
 * WHY A PATH WHOSE PARENT DOES NOT EXIST. `--add-dir` also declares the folder writable, and Codex
 * records it without creating it (measured on 0.145.0 and 0.163.0, and earlier on 0.156.1). Not existing is not
 * enough on its own: Linux's bubblewrap skips a missing writable root, but macOS Seatbelt turns it into
 * `(subpath <root>)`, which lets a sandboxed command `mkdir` the root and write inside it (read off
 * `codex-rs/sandboxing/src/seatbelt.rs` at `rust-v0.145.0` and `rust-v0.163.0`). So the declared root
 * is one level below {@link CODEX_CORRELATION_ROOT}, which nobody creates either: making the root
 * would need a write to its parent, and the parent is outside every writable root. The proof costs
 * no access the session did not already have.
 */
export const CODEX_CORRELATION_ROOT = 'codex-correlation';

/** The declared root's own name, under {@link CODEX_CORRELATION_ROOT}. */
const CODEX_CORRELATION_LEAF = 'unreachable';

/** The Codex flag that declares an extra workspace root. */
const CODEX_ADD_DIR = '--add-dir';

/** The launch arguments that make a Codex rollout carry `correlationToken` from its first record. */
export function codexCorrelationArguments(correlationToken: string): readonly string[] {
  return [CODEX_ADD_DIR, `${correlationToken}/${CODEX_CORRELATION_ROOT}/${CODEX_CORRELATION_LEAF}`];
}

/**
 * Whether `flag value` is the pair {@link codexCorrelationArguments} produces, for any session — or
 * the one-level spelling sessions launched before the root moved down still have recorded.
 */
export function isCodexCorrelationPair(flag: string, value: string | undefined): boolean {
  return (
    flag === CODEX_ADD_DIR &&
    value !== undefined &&
    (value.endsWith(`/${CODEX_CORRELATION_ROOT}/${CODEX_CORRELATION_LEAF}`) ||
      value.endsWith(`/${CODEX_CORRELATION_ROOT}`))
  );
}
