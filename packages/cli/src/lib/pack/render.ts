import {
  formatTaskRef,
  type PackAttempt,
  type PackChildCard,
  type PackModelOption,
  type PackNewOutcome,
  type PackRecommendation,
  type PackView,
  type RoutingPromptView,
  type RoutingSuggested,
} from '@ferretry/protocol';

/**
 * Which routing prompt is in effect, in words: "your routing prompt", "cleaned up by gpt-oss-120b on
 * 2026-10-22 and accepted", or "the default, rendered from the model catalogs".
 */
export function routingWords(source: RoutingPromptView['source'], suggested: RoutingSuggested | undefined): string {
  if (source === 'default') return 'the default, rendered from the model catalogs';
  if (suggested === undefined) return 'your routing prompt';
  return `${suggested.mode === 'generate' ? 'written' : 'cleaned up'} by ${suggested.by} on ${suggested.acceptedAt.slice(0, 10)} and accepted`;
}

/** The routing prompt in effect, headed by where it came from. */
export function renderRouting(routing: RoutingPromptView): string {
  return `Routing prompt (${routingWords(routing.source, routing.suggested)}):\n${routing.text}`;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th": where the routing prompt first names a model. */
const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10];
  return `${String(n)}${suffix ?? 'th'}`;
};

const optionLines = (option: PackModelOption): readonly string[] => {
  const effort = option.effort === undefined ? '' : ` at ${option.effort}`;
  const named = option.named === undefined ? '' : ` · named ${ordinal(option.named)} in the prompt`;
  const quota = option.quota.state === 'unknown' ? '' : ` · quota ${option.quota.summary}`;
  return [
    `${option.ready ? 'ready ' : 'cannot'} ${option.modelLabel} (${option.model})${effort} · ${option.runtime}${quota}${named}`,
    ...(option.refusal === undefined ? [] : [`       ${option.refusal.code}: ${option.refusal.message}`]),
    ...(option.command === undefined ? [] : [`       ${option.command}`]),
  ];
};

/** The models usable here now, in the order the daemon sorted them. */
export function renderAvailable(available: readonly PackModelOption[]): string {
  if (available.length === 0) return 'No model can run here now.';
  return [`Models usable here now (${String(available.length)}):`, ...available.flatMap(optionLines)].join('\n');
}

/**
 * A recommendation as a person (or a ferret) reads it: the routing prompt in effect and where it came from,
 * then every model usable here now (ready first, then by quota headroom). Nothing is matched against the
 * task: the asking ferret decides from both.
 */
export function renderPackRecommendation(recommendation: PackRecommendation): string {
  return [
    renderRouting(recommendation.routing),
    '',
    renderAvailable(recommendation.available),
    ...(recommendation.next === undefined ? [] : ['', `Start the first: ${recommendation.next}`]),
  ].join('\n');
}

/** The routing prompt in effect, as `guide show` prints it, and whether the last clean-up can be undone. */
export function renderGuide(view: PackView, bin: string): string {
  return [
    renderRouting(view.routing),
    ...(view.undo === undefined
      ? []
      : [
          '',
          `The prompt before the last accepted clean-up (${view.undo.savedAt.slice(0, 10)}) is kept: ${bin} guide undo puts it back.`,
        ]),
  ].join('\n');
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

const DECIDED_BY: Readonly<Record<Extract<PackNewOutcome, { outcome: 'started' }>['decidedBy'], string>> = {
  agent: 'you',
  routing: 'the routing prompt',
  jev: 'jev',
};

/** What `new` says about the sub-ferret's board card: which it is, and what the board could not do. */
function cardLines(card: PackChildCard | undefined): readonly string[] {
  if (card === undefined) return [];
  const where = card.project === undefined ? '' : ` on the ${card.project} board`;
  return [
    ...(card.id === undefined ? [] : [`Its card is ${formatTaskRef({ id: card.id })}${where}.`]),
    ...(card.note === undefined ? [] : [card.note]),
  ];
}

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
    `Started ${who} on ${view.config.agent}${view.config.model === undefined ? '' : `, ${view.config.model}`} — decided by ${DECIDED_BY[outcome.decidedBy]}.`,
    ...(outcome.note === undefined ? [] : [outcome.note]),
    ...cardLines(outcome.card),
    ...attempts,
    `Wait for its result: ${bin} wait ${view.config.id}`,
  ].join('\n');
}
