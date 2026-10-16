import type {
  ObservationSource,
  Proposal,
  ProposalCategory,
  ProposalTarget,
} from '../../../../protocol/src/lib/learning.ts';
import { matchesTombstone, observationId, sameRule, slugify } from './policy.ts';
import type { Observation, Tombstone } from './types.ts';

/**
 * PASSIVE LESSONS — one ferret's suggestion, folded into the inbox.
 *
 * Pure. The route resolves who is calling (from the session credential) and what the owner last said
 * (from that session's own transcript); this decides whether the rule is new, the same as one already
 * open — in which case its count and its evidence grow — or one the owner already rejected.
 */

/** The global instructions component lessons are applied to: `components/instructions/<name>.yaml`. */
export const GLOBAL_LESSONS_COMPONENT = 'lessons';

/** Its document, relative to the fleet asset tree. */
export const GLOBAL_LESSONS_FILE = 'instructions/lessons.md';

/** Where a lesson of `category` points before it is applied: the target is resolved again at apply. */
export function lessonTarget(category: ProposalCategory, project: string | undefined): ProposalTarget {
  return category === 'repo' && project !== undefined
    ? { kind: 'repo-instructions', path: project }
    : { kind: 'global-instructions', path: GLOBAL_LESSONS_FILE };
}

/** What the daemon itself attaches to a suggestion: never anything the ferret wrote. */
export interface SuggestionEvidence {
  /** The owner's latest message in the session, or the rule itself when the owner has said nothing. */
  readonly quote: string;
  readonly source: ObservationSource;
  readonly at: string;
  readonly turn?: number | undefined;
}

export interface SuggestionInput {
  readonly rule: string;
  readonly scope: ProposalCategory;
  readonly sessionId: string;
  readonly teammate?: string | undefined;
  readonly mode: 'interactive' | 'auto';
  readonly cwd: string;
  /** The project root the session works in; a `repo` lesson belongs to it. */
  readonly project: string;
  readonly evidence: SuggestionEvidence;
  readonly at: string;
}

export type SuggestionOutcome = 'filed' | 'merged' | 'previously-rejected';

export interface SuggestionResult {
  readonly outcome: SuggestionOutcome;
  readonly proposals: readonly Proposal[];
  /** The evidence to append, when it is new. */
  readonly observation?: Observation;
  /** The lesson the suggestion filed or strengthened. */
  readonly proposal?: Proposal;
}

const OPEN_STATES = new Set<Proposal['state']>(['pending', 'accepted', 'applied']);

/** A title short enough for a row: the rule's first sentence, capped. */
function titleOf(rule: string): string {
  const sentence = rule.split(/(?<=[.!?])\s/u)[0] ?? rule;
  return sentence.slice(0, 200);
}

/** Whether `proposal` is where a suggestion of this scope and project would merge. */
function sameHome(proposal: Proposal, scope: ProposalCategory, project: string): boolean {
  if (proposal.category !== scope) return false;
  return scope === 'global' || proposal.project === project;
}

/**
 * Folds one suggestion into the board. The quote is clipped to the evidence ceiling; a filing the
 * board already holds from the same session and quote adds nothing, so a ferret repeating itself in
 * one turn cannot inflate a lesson's count.
 */
export function fileSuggestion(
  existing: readonly Proposal[],
  tombstones: readonly Tombstone[],
  input: SuggestionInput,
): SuggestionResult {
  const rule = input.rule.trim();
  const identity = slugify(rule);
  const title = titleOf(rule);
  const rejected =
    matchesTombstone({ identity, title }, tombstones) ||
    existing.some(proposal => proposal.state === 'rejected' && sameRule(proposal.ruleText, rule));
  if (rejected) return { outcome: 'previously-rejected', proposals: existing };

  const quote = input.evidence.quote.trim().slice(0, 300) || rule.slice(0, 300);
  const observation: Observation = {
    id: observationId(input.sessionId, quote, rule),
    sessionId: input.sessionId,
    ...(input.teammate === undefined ? {} : { teammate: input.teammate }),
    mode: input.mode,
    cwd: input.cwd,
    repo: input.project,
    at: input.evidence.at,
    kind: 'suggestion',
    gist: rule.slice(0, 400),
    quote,
    source: input.evidence.source,
    verified: true,
    runId: 'passive',
    ...(input.evidence.turn === undefined ? {} : { turn: input.evidence.turn }),
  };
  const history = { at: input.at, event: `suggested:${input.sessionId}`, by: 'ferret' as const };

  const index = existing.findIndex(
    proposal =>
      OPEN_STATES.has(proposal.state) &&
      sameHome(proposal, input.scope, input.project) &&
      sameRule(proposal.ruleText, rule),
  );
  const current = existing[index];
  if (current !== undefined) {
    if (current.observationIds.includes(observation.id)) {
      return { outcome: 'merged', proposals: existing, proposal: current };
    }
    const observationIds = [...current.observationIds, observation.id];
    const merged: Proposal = {
      ...current,
      observationIds,
      count: current.count + 1,
      lastSeen: input.at > current.lastSeen ? input.at : current.lastSeen,
      history: [...current.history, history],
    };
    return {
      outcome: 'merged',
      proposals: existing.map(proposal => (proposal === current ? merged : proposal)),
      observation,
      proposal: merged,
    };
  }

  const created: Proposal = {
    id: `lesson_${identity}_${input.at.replace(/[^0-9]/gu, '')}`,
    category: input.scope,
    state: 'pending',
    title,
    ruleText: rule,
    target: lessonTarget(input.scope, input.project),
    observationIds: [observation.id],
    occurrences: 1,
    crossRepoCount: 1,
    firstSeen: input.at,
    lastSeen: input.at,
    identity,
    history: [history],
    source: 'passive',
    project: input.project,
    suggestedCategory: input.scope,
    count: 1,
  };
  return { outcome: 'filed', proposals: [...existing, created], observation, proposal: created };
}
