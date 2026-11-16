import type { TranscriptProvenance } from './protocol.ts';

/** Discovery evidence has served its purpose once a rollout is pinned and the resolution stamped. */
export function withoutResolvedTranscriptBaseline(provenance: TranscriptProvenance): TranscriptProvenance {
  if (provenance.identity !== 'correlated' || provenance.resolvedAt === undefined || provenance.baseline === undefined)
    return provenance;
  const { baseline: _baseline, ...resolved } = provenance;
  return resolved;
}
