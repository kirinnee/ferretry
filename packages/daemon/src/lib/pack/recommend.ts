/**
 * WHICH MODELS CAN RUN A TASK HERE, NOW (docs/pack-mode.md): the guide's use case for the task, each of
 * its candidates resolved to a runtime on this machine, and why any that cannot run cannot.
 *
 * "Usable now" is the fleet's own facts, read — never guessed: the runtime is an agent runtime, its
 * CLI is installed, its login is signed in with every secret it names, and its quota is not used up.
 * A candidate nobody here offers is still listed, last, with the reason, so a ferret (or its owner)
 * can see what the guide wanted.
 *
 * Pure: the guide and the fleet's facts in, a recommendation out.
 */
import type {
  FleetCredentialView,
  FleetMachineTool,
  FleetRuntimeView,
  GuideCandidate,
  GuideUseCase,
  ModelsGuide,
  PackCandidate,
  PackRecommendation,
  PackRefusal,
} from '@ferretry/protocol';

/** Everything recommend reads about this machine. */
export interface PackFleetFacts {
  readonly runtimes: readonly FleetRuntimeView[];
  readonly credentials: readonly FleetCredentialView[];
  readonly tools: readonly FleetMachineTool[];
}

/** A use case chosen for a task, and how. */
export interface MatchedUseCase {
  readonly useCase: GuideUseCase;
  readonly matchedBy: 'named' | 'words' | 'fallback';
}

const words = (text: string): readonly string[] => text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/gu) ?? [];

/** How many of a use case's words the task uses: a keyword phrase counts once, a title word once. */
function score(useCase: GuideUseCase, task: string): number {
  const lower = ` ${words(task).join(' ')} `;
  const phrases = [...(useCase.keywords ?? []), ...words(useCase.title).filter(word => word.length > 3)];
  return new Set(phrases.map(phrase => phrase.toLowerCase()).filter(phrase => lower.includes(` ${phrase} `))).size;
}

/**
 * The use case for a task: the one named, else the one whose words the task uses most (the guide's
 * order breaks a tie), else `everyday`, else the first. `undefined` only for a guide with none.
 */
export function matchUseCase(guide: ModelsGuide, task: string, named?: string): MatchedUseCase | undefined {
  if (named !== undefined) {
    const found = guide.useCases.find(useCase => useCase.id === named);
    if (found !== undefined) return { useCase: found, matchedBy: 'named' };
  }
  const scored = guide.useCases
    .map((useCase, index) => ({ useCase, index, score: score(useCase, task) }))
    .toSorted((left, right) => right.score - left.score || left.index - right.index);
  const top = scored[0];
  if (top === undefined) return undefined;
  if (top.score > 0) return { useCase: top.useCase, matchedBy: 'words' };
  const fallback = guide.useCases.find(useCase => useCase.id === 'everyday') ?? top.useCase;
  return { useCase: fallback, matchedBy: 'fallback' };
}

const refusal = (code: PackRefusal['code'], message: string, remedy?: string): PackRefusal => ({
  code,
  message,
  ...(remedy === undefined ? {} : { remedy }),
});

/** Whether a runtime's login has run out: a provider said so, or a window it reports is full. */
function exhausted(credential: FleetCredentialView): boolean {
  const usage = credential.usage;
  const full = (percent: number | undefined): boolean => percent !== undefined && percent >= 100;
  return usage.provider?.exhausted === true || full(usage.fiveHour.usedPercent) || full(usage.weekly.usedPercent);
}

/**
 * Why `runtime` cannot start a ferret on `model` now, or `undefined` when it can. Checked in the order
 * a person would fix them: the runtime, its CLI, its login, its quota, then the model.
 */
export function runtimeRefusal(
  runtime: FleetRuntimeView,
  model: string | undefined,
  facts: PackFleetFacts,
): PackRefusal | undefined {
  const name = runtime.name;
  if (!runtime.agent)
    return refusal(
      'not_agent',
      `${name} is for using its CLI yourself and cannot run sub-ferrets.`,
      'Pick an agent runtime.',
    );
  const tool = facts.tools.find(candidate => candidate.harness === runtime.harness);
  if (tool !== undefined && !tool.installed)
    return refusal(
      'cli_missing',
      `${tool.label} is not installed on this machine, so ${name} cannot start.`,
      `Install ${tool.label}, or pick another runtime.`,
    );
  const credential = facts.credentials.find(candidate => candidate.id === runtime.credential.id);
  const missing = credential?.environment?.missingSecrets ?? [];
  if (missing.length > 0)
    return refusal(
      'not_logged_in',
      `${name}'s login needs ${missing.join(', ')}, which is not set.`,
      'Pick another candidate.',
    );
  if ((credential?.status.word ?? runtime.credential.status) === 'needs_sign_in')
    return refusal(
      'not_logged_in',
      `${name}'s login (${runtime.credential.id}) needs signing in.`,
      'Pick another candidate.',
    );
  if (credential !== undefined && exhausted(credential))
    return refusal(
      'out_of_quota',
      `${name}'s login (${runtime.credential.id}) is out of quota.`,
      'Pick another candidate.',
    );
  if (!runtime.launch.available)
    return refusal('not_logged_in', `${name} cannot launch: ${runtime.launch.reason}`, 'Pick another candidate.');
  if (model !== undefined && !offers(runtime, model))
    return refusal(
      'model_unavailable',
      `${name} does not offer ${model}.`,
      `\`recommend\` lists the runtimes that do.`,
    );
  return undefined;
}

/** Whether a runtime offers a model, from its catalog when its login reads one, else its model set. */
export function offers(runtime: FleetRuntimeView, model: string): boolean {
  if (runtime.models !== undefined)
    return runtime.models.choices.some(choice => choice.id === model) || runtime.models.catalog.customIds;
  return (
    runtime.modelSet.source === 'model-set' &&
    runtime.modelSet.models.some(entry => entry.id === model && entry.available)
  );
}

/** The label a catalog gives a model id on this runtime, for display. */
const labelOn = (runtime: FleetRuntimeView, model: string): string | undefined =>
  runtime.models?.choices.find(choice => choice.id === model)?.label;

/**
 * The runtimes that could serve a candidate, best first: those whose login reads the candidate's own
 * catalog and lists the model, then those listing a model of the same LABEL from another catalog (the
 * same Claude model through Bedrock or a gateway). Each comes with the model id it would be started on.
 */
function servers(
  candidate: GuideCandidate,
  label: string | undefined,
  runtimes: readonly FleetRuntimeView[],
): readonly { readonly runtime: FleetRuntimeView; readonly model: string }[] {
  const harnessFits = (runtime: FleetRuntimeView): boolean =>
    candidate.harness === undefined || runtime.harness === candidate.harness;
  const exact = runtimes
    .filter(runtime => harnessFits(runtime) && runtime.models?.catalog.id === candidate.provider)
    .filter(runtime => runtime.models?.choices.some(choice => choice.id === candidate.model) === true)
    .map(runtime => ({ runtime, model: candidate.model }));
  if (label === undefined) return exact;
  const alike = runtimes.flatMap(runtime => {
    if (!harnessFits(runtime) || runtime.models === undefined || runtime.models.catalog.id === candidate.provider)
      return [];
    const choice = runtime.models.choices.find(entry => entry.label.toLowerCase() === label.toLowerCase());
    return choice === undefined ? [] : [{ runtime, model: choice.id }];
  });
  return [...exact, ...alike];
}

/** A candidate as one row: the first runtime here that can run it now, else the first refusal. */
function resolve(
  candidate: GuideCandidate,
  labels: ReadonlyMap<string, string>,
  facts: PackFleetFacts,
): Omit<PackCandidate, 'rank'> {
  const label = labels.get(`${candidate.provider}\u0000${candidate.model}`);
  const base = {
    provider: candidate.provider,
    model: candidate.model,
    ...(label === undefined ? {} : { modelLabel: label }),
    ...(candidate.harness === undefined ? {} : { harness: candidate.harness }),
    ...(candidate.effort === undefined ? {} : { effort: candidate.effort }),
    why: candidate.why,
  };
  const options = servers(candidate, label, facts.runtimes);
  const ready = options.find(option => runtimeRefusal(option.runtime, option.model, facts) === undefined);
  if (ready !== undefined)
    return {
      ...base,
      model: ready.model,
      modelLabel: labelOn(ready.runtime, ready.model) ?? label ?? ready.model,
      harness: ready.runtime.harness,
      runtime: ready.runtime.name,
      ready: true,
    };
  const first = options[0];
  if (first === undefined)
    return {
      ...base,
      ready: false,
      refusal: refusal(
        'model_unavailable',
        `No runtime on this machine offers ${label ?? candidate.model} (${candidate.provider}).`,
        'Add a login for that provider, or pick another candidate.',
      ),
    };
  return {
    ...base,
    runtime: first.runtime.name,
    ready: false,
    refusal: runtimeRefusal(first.runtime, first.model, facts) as PackRefusal,
  };
}

/** The labels every runtime's catalog gives each (provider, model), to recognise the same model resold. */
function catalogLabels(runtimes: readonly FleetRuntimeView[]): ReadonlyMap<string, string> {
  return new Map(
    runtimes.flatMap(runtime =>
      (runtime.models?.choices ?? []).map(
        choice => [`${runtime.models?.catalog.id ?? ''}\u0000${choice.id}`, choice.label] as const,
      ),
    ),
  );
}

/** The command that starts a ready candidate, for a binary called `bin`. */
export function newCommand(bin: string, candidate: PackCandidate): string {
  const effort = candidate.effort === undefined ? '' : ` --effort ${candidate.effort}`;
  return `${bin} new --runtime ${candidate.runtime ?? '<runtime>'} --model ${candidate.model}${effort} "<complete brief>"`;
}

/**
 * The recommendation for one task: its use case's candidates, the ready ones first and each group in
 * the guide's order. `labels` names models the runtimes here do not list (from the catalogs).
 */
export function recommend(
  input: { readonly task: string; readonly useCase?: string; readonly bin: string },
  guide: ModelsGuide,
  facts: PackFleetFacts,
  labels: ReadonlyMap<string, string> = new Map(),
): PackRecommendation | undefined {
  const matched = matchUseCase(guide, input.task, input.useCase);
  if (matched === undefined) return undefined;
  const known = new Map([...labels, ...catalogLabels(facts.runtimes)]);
  const rows = matched.useCase.candidates.map(candidate => resolve(candidate, known, facts));
  const ordered = [...rows.filter(row => row.ready), ...rows.filter(row => !row.ready)].map((row, index) => ({
    rank: index + 1,
    ...row,
  }));
  const first = ordered.find(row => row.ready);
  return {
    task: input.task,
    useCase: { id: matched.useCase.id, title: matched.useCase.title, matchedBy: matched.matchedBy },
    guideSource: guide.source,
    candidates: ordered,
    ...(first === undefined ? {} : { next: newCommand(input.bin, first) }),
  };
}
