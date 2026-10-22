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
import type { CodexDiscoveryPacer } from './discovery-pacing.ts';

/** Lists the rollouts under a home, saying which contain the caller's correlation token. */
export interface CodexRolloutIndex {
  /**
   * Every rollout under `home`, each marked with whether it carries `correlationToken`. A rollout whose
   * id is in `skip` can never be chosen, so an index MAY leave it out rather than look at it again.
   */
  candidates(
    home: string,
    correlationToken: string,
    skip?: ReadonlySet<string>,
  ): Promise<readonly CodexRolloutCandidate[]>;
  /** How many times the home's listing has been seen to change, when the index can tell. */
  changes?(home: string): number;
  /**
   * How many file events have been heard in the directories a new rollout of `home` would appear in, or
   * `undefined` while any of them is not watched live — so an unchanged count proves the home quiet.
   */
  heard?(home: string): number | undefined;
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
  /**
   * `pacer` is daemon-wide, shared by every resolver, and decides how often an unresolved session may
   * walk the home; without one every read discovers.
   */
  constructor(
    private readonly rollouts: CodexRolloutIndex,
    private readonly claims: TranscriptClaims,
    private readonly store: TranscriptProvenanceStore,
    private readonly clock: ResolverClock,
    private readonly pacer?: CodexDiscoveryPacer,
  ) {}

  /**
   * The transcript file for one session, discovering and persisting it when that is possible.
   *
   * `undefined` means this session has no transcript the daemon can honestly name — never "look
   * again somewhere less certain".
   *
   * `startedAt` reads when the session started, for the pacer; it is asked only when a pace begins.
   */
  async file(
    sessionId: string,
    provenance: TranscriptProvenance | undefined,
    startedAt?: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    if (provenance === undefined) return undefined;
    if (provenance.file !== undefined) return provenance.file;
    const resolve = async (): Promise<TranscriptProvenance | undefined> => {
      const resolved = await this.discover(sessionId, provenance);
      if (resolved !== undefined) await this.store.record(sessionId, resolved);
      return resolved;
    };
    // A record with no token is answered without looking, so it is never paced either.
    if (this.pacer === undefined || provenance.correlationToken === undefined) return (await resolve())?.file;
    const changes = this.rollouts.changes?.bind(this.rollouts);
    const heard = this.rollouts.heard?.bind(this.rollouts);
    const resolved = await this.pacer.pace(
      sessionId,
      provenance,
      changes === undefined ? undefined : () => changes(provenance.home),
      resolve,
      startedAt,
      heard === undefined ? undefined : () => heard(provenance.home),
    );
    return resolved?.file;
  }

  /** The rollout this session provably owns, as a completed provenance record. */
  private async discover(
    sessionId: string,
    provenance: TranscriptProvenance,
  ): Promise<TranscriptProvenance | undefined> {
    // Without a token nothing can prove ownership, and the walk would only produce candidates the
    // selection is required to refuse. Not looking is the same answer, reached cheaply.
    if (provenance.correlationToken === undefined) return undefined;
    const baseline = provenance.baseline ?? [];
    const skip = new Set(baseline);
    // The baseline is every rollout that existed before this session launched — never its own — so the
    // index need not look at those again; on a home of thousands, they are nearly all of them.
    const candidates = await this.rollouts.candidates(provenance.home, provenance.correlationToken, skip);
    // The claims are every other session's configuration, read whole — asked for on every tick while a
    // Codex session is still undiscovered, which on a large fleet was most of the daemon's file reads.
    // With no correlated candidate outside the baseline the selection is empty whatever is claimed, so
    // they are asked only when a candidate could win.
    if (!candidates.some(candidate => candidate.correlated && !skip.has(candidate.id))) return undefined;
    const chosen = selectCodexRollout(candidates, { baseline, claimed: await this.claims.claimed(sessionId) });
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
