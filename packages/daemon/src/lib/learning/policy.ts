import { createHash } from 'node:crypto';
import type { Observation, Proposal, Tombstone } from './types.ts';

/** Stable kebab-case identity from arbitrary human or miner text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Canonical form for case- and whitespace-insensitive textual matching. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A candidate quote needs a real, non-trivial occurrence in the source corpus. */
export function verifyQuote(quote: string, corpus: string): boolean {
  const needle = normalizeForMatch(quote);
  return needle.length >= 3 && normalizeForMatch(corpus).includes(needle);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

/** Content address makes append retries idempotent without trusting miner identifiers. */
export function observationId(sessionId: string, quote: string, gist: string): string {
  return `obs_${hash(`${sessionId}\0${normalizeForMatch(quote)}\0${normalizeForMatch(gist)}`)}`;
}

export function titleHash(title: string): string {
  return hash(normalizeForMatch(title));
}

export type Strength = 'weak' | 'normal' | 'strong';

export function strengthOf(occurrences: number): Strength {
  if (occurrences >= 5) return 'strong';
  if (occurrences <= 1) return 'weak';
  return 'normal';
}

/** Tombstones match both a stable identity and a renamed-but-equivalent title. */
export function matchesTombstone(
  candidate: Pick<Proposal, 'identity' | 'title'>,
  tombstones: readonly Tombstone[],
): boolean {
  const candidateTitleHash = titleHash(candidate.title);
  return tombstones.some(
    tombstone => tombstone.identity === candidate.identity || tombstone.titleHash === candidateTitleHash,
  );
}

/**
 * Rebuild presentation counters from verified evidence. Missing evidence is
 * removed so proposal counters never claim support that cannot be displayed.
 */
export function recomputeProposal(proposal: Proposal, observations: ReadonlyMap<string, Observation>): Proposal {
  const resolved = proposal.observationIds
    .map(id => observations.get(id))
    .filter((observation): observation is Observation => observation !== undefined);
  const times = resolved.map(observation => observation.at).toSorted();

  return {
    ...proposal,
    observationIds: resolved.map(observation => observation.id),
    occurrences: new Set(resolved.map(observation => observation.sessionId)).size,
    crossRepoCount: new Set(resolved.map(observation => observation.repo)).size,
    firstSeen: times[0] ?? proposal.firstSeen,
    lastSeen: times.at(-1) ?? proposal.lastSeen,
  };
}

/** Parse an append-only JSONL file without allowing one torn line to poison prior evidence. */
export function parseJsonl<T>(text: string): readonly T[] {
  const records: T[] = [];
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (value.length === 0) continue;
    try {
      records.push(JSON.parse(value) as T);
    } catch {
      // A corrupt tail is ignored; valid preceding append records remain readable.
    }
  }
  return records;
}
