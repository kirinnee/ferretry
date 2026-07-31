import type { ObservationKind, ObservationSource, Proposal } from './types.ts';
import type { SessionDigest } from './extract.ts';
import { matchesTombstone, observationId, recomputeProposal, slugify, verifyQuote } from './policy.ts';
import type { Observation, Tombstone } from './types.ts';

/** Untrusted observation emitted by a miner session. */
export interface MinerObservation {
  readonly key: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly gist: string;
  readonly quote: string;
  readonly source?: string;
}

/** Untrusted candidate rule emitted by a miner session. */
export interface MinerProposal {
  readonly identity?: string;
  readonly title: string;
  readonly ruleText: string;
  readonly target?: 'global-agent-guidance' | 'automation-guidance';
  readonly anchor?: string;
  readonly observationKeys: readonly string[];
}

export interface MinerOutput {
  readonly observations?: readonly MinerObservation[];
  readonly proposals?: readonly MinerProposal[];
}

export interface AggregateStats {
  readonly observationsProposed: number;
  readonly observationsVerified: number;
  readonly rejectedQuotes: number;
  readonly proposalsCreated: number;
  readonly proposalsStrengthened: number;
  readonly proposalsSuppressedByTombstone: number;
}

export interface AggregateResult {
  readonly observations: readonly Observation[];
  readonly proposals: readonly Proposal[];
  readonly stats: AggregateStats;
}

const OBSERVATION_KINDS = new Set<ObservationKind>([
  'correction',
  'roadblock',
  'preference',
  'recurring_task',
  'tooling_failure',
]);

function normalizeKind(kind: string): ObservationKind {
  return OBSERVATION_KINDS.has(kind as ObservationKind) ? (kind as ObservationKind) : 'correction';
}

function normalizeSource(source: string | undefined, digest: SessionDigest): ObservationSource {
  return source === 'teammate' || digest.humanMessages === 0 ? 'teammate' : 'human';
}

function targetFor(candidate: MinerProposal): Proposal['target'] {
  return candidate.target === 'automation-guidance'
    ? { kind: 'automation-guidance', path: 'automation.md', anchor: candidate.anchor }
    : { kind: 'global-agent-guidance', path: 'guidance.md', anchor: candidate.anchor ?? '## Agent rules' };
}

function copyProposal(proposal: Proposal): Proposal {
  return {
    ...proposal,
    observationIds: [...proposal.observationIds],
    history: proposal.history.map(entry => ({ ...entry })),
  };
}

/**
 * Applies one miner result using only evidence whose quote appears in the saved
 * human corpus. Miner counts and identities are never trusted as authority.
 */
export function applyMinerOutput(
  existing: readonly Proposal[],
  tombstones: readonly Tombstone[],
  output: MinerOutput,
  digestsById: ReadonlyMap<string, SessionDigest>,
  knownObservations: ReadonlyMap<string, Observation>,
  runId: string,
  at: string,
): AggregateResult {
  const rawObservations = output.observations ?? [];
  const stats = {
    observationsProposed: rawObservations.length,
    observationsVerified: 0,
    rejectedQuotes: 0,
    proposalsCreated: 0,
    proposalsStrengthened: 0,
    proposalsSuppressedByTombstone: 0,
  };
  const verifiedByKey = new Map<string, Observation>();
  const verified: Observation[] = [];

  for (const raw of rawObservations) {
    const digest = digestsById.get(raw.sessionId);
    if (digest === undefined || !verifyQuote(raw.quote, digest.corpus)) {
      stats.rejectedQuotes += 1;
      continue;
    }
    const quote = raw.quote.slice(0, 300);
    const observation: Observation = {
      id: observationId(raw.sessionId, quote, raw.gist),
      sessionId: raw.sessionId,
      teammate: digest.teammate,
      mode: digest.mode,
      cwd: digest.cwd,
      repo: digest.repo,
      at: digest.at || at,
      kind: normalizeKind(raw.kind),
      gist: raw.gist.slice(0, 400),
      quote,
      source: normalizeSource(raw.source, digest),
      verified: true,
      runId,
    };
    verified.push(observation);
    verifiedByKey.set(raw.key, observation);
    stats.observationsVerified += 1;
  }

  const proposals = existing.map(copyProposal);
  const observationIndex = new Map(knownObservations);
  for (const observation of verified) observationIndex.set(observation.id, observation);

  for (const candidate of output.proposals ?? []) {
    const observationIds = [
      ...new Set(candidate.observationKeys.map(key => verifiedByKey.get(key)?.id).filter(Boolean)),
    ] as string[];
    const identity = slugify(candidate.identity ?? candidate.title);
    const ruleText = candidate.ruleText.trim();
    if (
      observationIds.length === 0 ||
      identity.length === 0 ||
      candidate.title.trim().length === 0 ||
      ruleText.length === 0
    )
      continue;
    if (matchesTombstone({ identity, title: candidate.title }, tombstones)) {
      stats.proposalsSuppressedByTombstone += 1;
      continue;
    }

    const existingIndex = proposals.findIndex(
      proposal => proposal.identity === identity && (proposal.state === 'pending' || proposal.state === 'accepted'),
    );
    if (existingIndex >= 0) {
      const current = proposals[existingIndex];
      if (current === undefined) continue;
      const mergedIds = [...new Set([...current.observationIds, ...observationIds])];
      if (mergedIds.length === current.observationIds.length) continue;
      const recomputed = recomputeProposal({ ...current, observationIds: mergedIds }, observationIndex);
      proposals[existingIndex] = {
        ...recomputed,
        history: [...current.history, { at, event: `strengthened:${runId}`, by: 'miner' }],
      };
      stats.proposalsStrengthened += 1;
      continue;
    }

    const base: Proposal = {
      id: `proposal_${identity}_${runId}`,
      category: 'global',
      state: 'pending',
      title: candidate.title.trim().slice(0, 200),
      ruleText,
      target: targetFor(candidate),
      observationIds,
      occurrences: 1,
      crossRepoCount: 1,
      firstSeen: at,
      lastSeen: at,
      identity,
      history: [{ at, event: `proposed:${runId}`, by: 'miner' }],
    };
    proposals.push(recomputeProposal(base, observationIndex));
    stats.proposalsCreated += 1;
  }

  return { observations: verified, proposals, stats };
}
