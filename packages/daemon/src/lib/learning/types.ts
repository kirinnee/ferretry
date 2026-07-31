import type {
  ObservationKind,
  ObservationSource,
  Proposal,
  ProposalState,
  RunManifest,
} from '../../../../protocol/src/lib/learning.ts';

export type { ObservationKind, ObservationSource, Proposal, ProposalState, RunManifest };

/** Verified, append-only evidence retained by the daemon. */
export interface Observation {
  readonly id: string;
  readonly sessionId: string;
  readonly teammate?: string;
  readonly mode: 'interactive' | 'auto';
  readonly cwd: string;
  readonly repo: string;
  readonly at: string;
  readonly kind: ObservationKind;
  readonly gist: string;
  readonly quote: string;
  readonly source: ObservationSource;
  readonly verified: true;
  readonly runId: string;
}

/** A rejected identity must never be proposed again. */
export interface Tombstone {
  readonly identity: string;
  readonly titleHash: string;
  readonly ruleGist: string;
  readonly rejectedAt: string;
  readonly note?: string;
}

export interface LearningState {
  readonly watermarkAt?: string;
  readonly watermarkId?: string;
  readonly lastRunAt?: string;
  readonly lastRunId?: string;
  readonly lastSpawnAt?: string;
  readonly runningRunId?: string;
}
