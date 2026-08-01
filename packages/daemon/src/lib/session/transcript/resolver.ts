/**
 * Turning a session's provenance record into the transcript file a reader can open.
 *
 * For a `minted` record this is a lookup: the file was named at creation. For an `undiscovered`
 * Codex record it is a discovery pass against the baseline and the correlation token, run on
 * demand and persisted the first time it succeeds — so the expensive walk happens once per session
 * rather than once per read, and every later reader sees the same answer.
 *
 * WHY DISCOVERY IS LAZY RATHER THAN PART OF THE START. Codex writes its rollout after it boots, so
 * a discovery run inside the start would find nothing and would have to either block the start or
 * record a failure that is not one. Running it when a reader first asks means the answer arrives as
 * soon as it exists, and a session whose harness never wrote a rollout simply never resolves —
 * which is the truth about that session.
 */

import type { TranscriptProvenance } from '@ferretry/protocol';
import type { CodexRolloutCandidate } from './codex-rollout.ts';
import { selectCodexRollout } from './codex-rollout.ts';

/** Lists the rollouts under a home, saying which contain the caller's correlation token. */
export interface CodexRolloutIndex {
  candidates(home: string, correlationToken: string): Promise<readonly CodexRolloutCandidate[]>;
}

/** Persists a resolution back onto the session's own configuration document. */
export interface TranscriptProvenanceStore {
  record(sessionId: string, provenance: TranscriptProvenance): Promise<void>;
}

/** Rollouts already attributed to other sessions, so no two sessions can claim one file. */
export interface TranscriptClaims {
  claimed(exceptSessionId: string): Promise<readonly string[]>;
}

/** A clock the resolver stamps discoveries with. */
export interface ResolverClock {
  now(): string;
}

export class SessionTranscriptResolver {
  constructor(
    private readonly rollouts: CodexRolloutIndex,
    private readonly claims: TranscriptClaims,
    private readonly store: TranscriptProvenanceStore,
    private readonly clock: ResolverClock,
  ) {}

  /**
   * The transcript file for one session, discovering and persisting it when that is possible.
   *
   * `undefined` means this session has no transcript the daemon can honestly name — never "look
   * again somewhere less certain".
   */
  async file(sessionId: string, provenance: TranscriptProvenance | undefined): Promise<string | undefined> {
    if (provenance === undefined) return undefined;
    if (provenance.file !== undefined) return provenance.file;
    const resolved = await this.discover(sessionId, provenance);
    if (resolved === undefined) return undefined;
    await this.store.record(sessionId, resolved);
    return resolved.file;
  }

  /** The rollout this session provably owns, as a completed provenance record. */
  private async discover(
    sessionId: string,
    provenance: TranscriptProvenance,
  ): Promise<TranscriptProvenance | undefined> {
    // Without a token nothing can prove ownership, and the walk would only produce candidates the
    // selection is required to refuse. Not looking is the same answer, reached cheaply.
    if (provenance.correlationToken === undefined) return undefined;
    const candidates = await this.rollouts.candidates(provenance.home, provenance.correlationToken);
    const chosen = selectCodexRollout(candidates, {
      baseline: provenance.baseline ?? [],
      claimed: await this.claims.claimed(sessionId),
    });
    if (chosen === undefined) return undefined;
    return {
      ...provenance,
      harnessSessionId: chosen.id,
      identity: 'correlated',
      file: chosen.file,
      resolvedAt: this.clock.now(),
    };
  }
}

/** The candidate shape a rollout index produces, re-exported so adapters import one module. */
export type { CodexRolloutCandidate };
