import type {
  GuideSuggested,
  ModelsGuide,
  PackAttempt,
  PackCandidate,
  PackNewOutcome,
  PackRecommendation,
  PackView,
} from '@ferretry/protocol';

const MATCHED: Readonly<Record<PackRecommendation['useCase']['matchedBy'], string>> = {
  named: 'as named',
  words: "from the task's words",
  fallback: 'no use case matched, so the everyday one',
};

/**
 * Which guide was used, in words: "your models guide", "the built-in guide", or "your guide, suggested by
 * gpt-oss-120b on 2026-10-22 and accepted" for one accepted from a suggestion.
 */
export function guideWords(source: ModelsGuide['source'], suggested: GuideSuggested | undefined): string {
  if (source === 'derived') return 'the built-in guide';
  if (suggested === undefined) return 'your models guide';
  return `your guide, suggested by ${suggested.by} on ${suggested.acceptedAt.slice(0, 10)} and ${suggested.partial === true ? 'partly accepted' : 'accepted'}`;
}

/** A candidate's quota, when anything measured it. */
const quotaWords = (candidate: PackCandidate): string =>
  candidate.quota === undefined || candidate.quota.state === 'unknown' ? '' : ` · quota ${candidate.quota.summary}`;

/**
 * A recommendation as a person (or a ferret) reads it: the use case and the guide it came from, each
 * candidate (ready ones first, then by quota headroom) with why any moved down, and the guide's routing
 * prompt — the owner's guidance on choosing, current as of this answer.
 */
export function renderPackRecommendation(recommendation: PackRecommendation): string {
  const lines = [
    `Use case: ${recommendation.useCase.title} (${recommendation.useCase.id}, ${MATCHED[recommendation.useCase.matchedBy]}; ${guideWords(recommendation.guideSource, recommendation.guideSuggested)})`,
    '',
  ];
  for (const candidate of recommendation.candidates) {
    const model = candidate.modelLabel === undefined ? candidate.model : `${candidate.modelLabel} (${candidate.model})`;
    const effort = candidate.effort === undefined ? '' : ` · effort ${candidate.effort}`;
    const where = candidate.runtime === undefined ? '' : ` on ${candidate.runtime}`;
    lines.push(
      `${String(candidate.rank)}. ${candidate.ready ? 'ready  ' : 'cannot '} ${model}${where}${effort}${quotaWords(candidate)}`,
    );
    lines.push(`   ${candidate.why}`);
    if (candidate.movedDown !== undefined) lines.push(`   moved down: ${candidate.movedDown}`);
    if (candidate.refusal !== undefined) lines.push(`   ${candidate.refusal.code}: ${candidate.refusal.message}`);
  }
  if (recommendation.routing !== undefined)
    lines.push('', 'How to choose (the routing guidance):', recommendation.routing);
  lines.push(
    '',
    recommendation.next === undefined ? 'Nothing can run it here now.' : `Start the first: ${recommendation.next}`,
  );
  return lines.join('\n');
}

/** The guide in effect, as `guide show` prints it: where it came from, the routing guidance, the use cases. */
export function renderGuide(view: PackView): string {
  const guide = view.guide;
  const lines = [`Models guide: ${guideWords(guide.source, guide.suggested)}`];
  if (guide.routing !== undefined)
    lines.push(
      '',
      `Routing guidance (${guide.routing.source === 'file' ? 'written in models-guide.yaml' : 'rendered from the use cases'}):`,
      guide.routing.prompt,
      '',
      `In every Pack ferret's system prompt: ${guide.routing.short}`,
    );
  lines.push('', `Use cases (${String(guide.useCases.length)}):`);
  for (const useCase of guide.useCases) {
    lines.push(`- ${useCase.title} (${useCase.id})`);
    for (const [index, candidate] of useCase.candidates.entries()) {
      const harness = candidate.harness === undefined ? '' : ` (${candidate.harness})`;
      const effort = candidate.effort === undefined ? '' : ` · effort ${candidate.effort}`;
      lines.push(
        `  ${String(index + 1)}. ${candidate.provider}/${candidate.model}${harness}${effort} — ${candidate.why}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The "reply OK" check of one attempt: `probe OK 640 ms`, `probe OK, cached`, or `probe failed 3436 ms`
 * (`shared` when another start's probe of the same model was already running). A refused attempt that
 * carries a time is one whose probe failed; one without a time passed it and was refused by the start.
 */
const probeWords = (attempt: PackAttempt): string => {
  if (attempt.probe === undefined) return '';
  const cached = attempt.probe === 'cached';
  if (attempt.outcome === 'refused' && attempt.probeMs !== undefined)
    return cached ? ' (probe failed, shared)' : ` (probe failed ${String(attempt.probeMs)} ms)`;
  if (cached) return ' (probe OK, cached)';
  return attempt.probeMs === undefined ? ' (probe OK)' : ` (probe OK ${String(attempt.probeMs)} ms)`;
};

const attemptLine = (attempt: PackAttempt): string => {
  const model = attempt.model === undefined ? '' : ` ${attempt.model}`;
  const probe = probeWords(attempt);
  return attempt.outcome === 'started'
    ? `  started ${attempt.runtime}${model}${probe}`
    : `  refused ${attempt.runtime}${model}${probe} — ${attempt.refusal?.code ?? 'refused'}: ${attempt.refusal?.message ?? ''}`;
};

/** What `new` did: the ferret it started and how, or the refusal and every attempt. */
export function renderPackNewOutcome(outcome: PackNewOutcome, bin: string): string {
  const attempts = outcome.attempts.map(attemptLine);
  if (outcome.outcome === 'refused')
    return [
      `refused (${outcome.refusal.code}): ${outcome.refusal.message}`,
      ...(outcome.refusal.remedy === undefined ? [] : [outcome.refusal.remedy]),
      ...(attempts.length === 0 ? [] : ['', 'Tried:', ...attempts]),
    ].join('\n');
  const view = outcome.view;
  const who = view.config.teammate === undefined ? view.config.id : `${view.config.teammate} (${view.config.id})`;
  return [
    `Started ${who} on ${view.config.agent}${view.config.model === undefined ? '' : `, ${view.config.model}`} — decided by ${outcome.decidedBy === 'agent' ? 'you' : outcome.decidedBy}.`,
    ...(outcome.note === undefined ? [] : [outcome.note]),
    ...attempts,
    `Wait for its result: ${bin} wait ${view.config.id}`,
  ].join('\n');
}
