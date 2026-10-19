import type { PackAttempt, PackNewOutcome, PackRecommendation } from '@ferretry/protocol';

const MATCHED: Readonly<Record<PackRecommendation['useCase']['matchedBy'], string>> = {
  named: 'as named',
  words: "from the task's words",
  fallback: 'no use case matched, so the everyday one',
};

/** A recommendation as a person (or a ferret) reads it: the use case, then each candidate, ready ones first. */
export function renderPackRecommendation(recommendation: PackRecommendation): string {
  const lines = [
    `Use case: ${recommendation.useCase.title} (${recommendation.useCase.id}, ${MATCHED[recommendation.useCase.matchedBy]}; ${recommendation.guideSource === 'file' ? 'your models guide' : 'the built-in guide'})`,
    '',
  ];
  for (const candidate of recommendation.candidates) {
    const model = candidate.modelLabel === undefined ? candidate.model : `${candidate.modelLabel} (${candidate.model})`;
    const effort = candidate.effort === undefined ? '' : ` · effort ${candidate.effort}`;
    const where = candidate.runtime === undefined ? '' : ` on ${candidate.runtime}`;
    lines.push(`${String(candidate.rank)}. ${candidate.ready ? 'ready  ' : 'cannot '} ${model}${where}${effort}`);
    lines.push(`   ${candidate.why}`);
    if (candidate.refusal !== undefined) lines.push(`   ${candidate.refusal.code}: ${candidate.refusal.message}`);
  }
  lines.push('', recommendation.next === undefined ? 'Nothing can run it here now.' : `Start the first: ${recommendation.next}`);
  return lines.join('\n');
}

const attemptLine = (attempt: PackAttempt): string => {
  const model = attempt.model === undefined ? '' : ` ${attempt.model}`;
  const probe = attempt.probe === undefined ? '' : attempt.probe === 'cached' ? ' (probe cached)' : ` (probe ${String(attempt.probeMs ?? 0)}ms)`;
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
