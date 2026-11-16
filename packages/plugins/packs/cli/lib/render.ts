import type {
  PackModelOption,
  PackRecommendation,
  PackView,
  RoutingPromptView,
  RoutingSuggested,
} from '../../contract/index.ts';

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
