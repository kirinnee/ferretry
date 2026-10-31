/**
 * WHICH MODELS CAN RUN HERE, NOW (docs/pack-mode.md § `fy recommend`): every model a runtime on this machine
 * offers, each resolved to the runtime with the most quota headroom that could start it, and why any that
 * cannot start cannot — the ready ones first, then by quota headroom. Nothing is matched against a task: the
 * routing prompt says how to choose, and the asking ferret (or Jev) chooses.
 *
 * "Usable now" is the fleet's own facts, read — never guessed: the runtime is an agent runtime, its CLI is
 * installed, its launcher is one a start can run, its login is signed in with every secret it names, and its
 * quota is not used up.
 *
 * Also the order `fy new --auto` tries in the agent's mode: the ready models the routing prompt NAMES, in the
 * order it names them, then the ready model with the most headroom.
 *
 * Pure: the fleet's facts and the routing prompt in, the list out.
 */
import type {
  FleetCredentialView,
  FleetMachineTool,
  FleetRuntimeView,
  PackFleetModel,
  PackModelOption,
  PackQuota,
  PackRefusal,
} from '@ferretry/protocol';
import { usdWords } from '@ferretry/fleet';
import { modelVocabulary, namedModels } from '@ferretry/protocol';
import type { PaneLimit } from '../usage/pane-limit.ts';
import { QUOTA_RANK, quotaOf } from './quota.ts';

/** Everything recommend reads about this machine. */
export interface PackFleetFacts {
  readonly runtimes: readonly FleetRuntimeView[];
  readonly credentials: readonly FleetCredentialView[];
  readonly tools: readonly FleetMachineTool[];
  /**
   * Why a start would refuse to launch a runtime, by its wrapper name — the start's OWN resolution of
   * the published launcher, so "ready" here is a runtime `fy new` can actually launch. Absent: launchable.
   */
  readonly unlaunchable: Readonly<Record<string, string>>;
  /**
   * The logins whose sessions' panes say they are out of quota, by credential id. Absent: none are. Read
   * from the panes because a spend limit is something only the pane announces.
   */
  readonly paneLimits?: ReadonlyMap<string, PaneLimit>;
  /** Now, so a quota window whose reset time has passed counts as fresh. Absent: no reset is assumed. */
  readonly now?: string;
}

const refusal = (code: PackRefusal['code'], message: string, remedy?: string): PackRefusal => ({
  code,
  message,
  ...(remedy === undefined ? {} : { remedy }),
});

/** The quota headroom of a runtime's login now. */
const runtimeQuota = (runtime: FleetRuntimeView, facts: PackFleetFacts): PackQuota =>
  quotaOf(
    facts.credentials.find((candidate: FleetCredentialView) => candidate.id === runtime.credential.id),
    facts.now,
    facts.paneLimits?.get(runtime.credential.id),
  );

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
  const budget = overBudget(facts.credentials.find(candidate => candidate.id === runtime.credential.id));
  if (budget !== undefined)
    return refusal(
      'over_budget',
      `${name}'s login (${runtime.credential.id}) ${budget}`,
      'Pick another model; this one is back when the budget resets.',
    );
  const unlaunchable = facts.unlaunchable[runtime.wrapper];
  if (unlaunchable !== undefined)
    return refusal('cli_missing', `${name} cannot be launched: ${unlaunchable}`, 'Pick another runtime.');
  if (runtime.disabled !== undefined)
    return refusal(
      'disabled',
      `${name} cannot launch: ${runtime.launch.available ? 'it is disabled' : runtime.launch.reason}.`,
      'Pick another model.',
    );
  const credential = facts.credentials.find(candidate => candidate.id === runtime.credential.id);
  const missing = credential?.environment?.missingSecrets ?? [];
  if (missing.length > 0)
    return refusal(
      'not_logged_in',
      `${name}'s login needs ${missing.join(', ')}, which is not set.`,
      'Pick another model.',
    );
  if ((credential?.status.word ?? runtime.credential.status) === 'needs_sign_in')
    return refusal(
      'not_logged_in',
      `${name}'s login (${runtime.credential.id}) needs signing in.`,
      'Pick another model.',
    );
  const quota =
    credential === undefined ? undefined : quotaOf(credential, facts.now, facts.paneLimits?.get(runtime.credential.id));
  if (quota?.state === 'exhausted')
    return refusal(
      'out_of_quota',
      `${name}'s login (${runtime.credential.id}) is ${quota.summary}.`,
      'Pick another model.',
    );
  if (!runtime.launch.available)
    return refusal('not_logged_in', `${name} cannot launch: ${runtime.launch.reason}`, 'Pick another model.');
  if (model !== undefined && !offers(runtime, model))
    return refusal('model_unavailable', `${name} does not offer ${model}.`, '`recommend` lists the runtimes that do.');
  return undefined;
}

/**
 * "spent $41.20 of its $40.00 daily trigger on this machine; back at 2026-10-31T07:00:00.000Z" — or
 * `undefined` when the login's budget holds nothing. The worse period speaks; a tie goes to the longer.
 */
export function overBudget(credential: FleetCredentialView | undefined): string | undefined {
  const budget = credential?.budget;
  if (budget === undefined || budget.level === 'ok') return undefined;
  const periods = (['weekly', 'daily'] as const).flatMap(period => {
    const view = budget[period];
    return view === undefined || view.level === 'ok' ? [] : [{ period, view }];
  });
  const speaking = periods.find(entry => entry.view.level === budget.level) ?? periods[0];
  if (speaking === undefined) return undefined;
  const { period, view } = speaking;
  const hard = view.level === 'over_hard';
  const limit = (hard ? view.hard : view.trigger) ?? 0;
  return `spent ${usdWords(view.spentUsd)} of its ${usdWords(limit)} ${period} ${hard ? 'hard limit' : 'trigger'} on this machine; back at ${view.resetsAt}`;
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

/** One model one runtime offers, as the list reads it. */
interface Offer {
  readonly runtime: FleetRuntimeView;
  readonly id: string;
  readonly label: string;
  readonly tier?: PackModelOption['tier'];
  readonly efforts: readonly string[];
}

/** What an agent runtime offers: its catalog's choices, else its model set's available models. */
function offersOf(runtime: FleetRuntimeView): readonly Offer[] {
  if (!runtime.agent) return [];
  if (runtime.models !== undefined)
    return runtime.models.choices.map(choice => ({
      runtime,
      id: choice.id,
      label: choice.label,
      ...(choice.tier === undefined ? {} : { tier: choice.tier }),
      efforts: choice.efforts,
    }));
  if (runtime.modelSet.source !== 'model-set') return [];
  return runtime.modelSet.models
    .filter(entry => entry.available)
    .map(entry => ({ runtime, id: entry.id, label: entry.id, efforts: [] }));
}

/** The key one row of the list gathers its offers under: the same model resold is one row. */
const rowKey = (label: string): string => label.trim().toLowerCase();

/** The command that starts a model on a runtime, for a binary called `bin`. */
export function newCommand(bin: string, option: Pick<PackModelOption, 'runtime' | 'model' | 'effort'>): string {
  const effort = option.effort === undefined ? '' : ` --effort ${option.effort}`;
  return `${bin} new --runtime ${option.runtime} --model ${option.model}${effort} --name "<short task title>" "<complete brief>"`;
}

const TIER_ORDER: Readonly<Record<NonNullable<PackModelOption['tier']>, number>> = { best: 0, balanced: 1, fast: 2 };

/** Most headroom first: the band, then the share left (unmeasured counts as all of it). */
const headroom = (left: PackQuota, right: PackQuota): number =>
  QUOTA_RANK[left.state] - QUOTA_RANK[right.state] || (right.leftPercent ?? 100) - (left.leftPercent ?? 100);

/**
 * Every model a runtime here offers, one row each: the runtime with the most headroom among those that could
 * start it now (else the first, with why not), where the routing prompt names it and the effort it names.
 * The ready rows come first, then by quota headroom; the prompt's order, the tier and the label break ties.
 */
export function availableModels(
  facts: PackFleetFacts,
  vocabulary: readonly PackFleetModel[],
  prompt: string,
  bin: string,
): readonly PackModelOption[] {
  const named = new Map<string, { readonly position: number; readonly effort?: string }>();
  for (const entry of namedModels(prompt, modelVocabulary(vocabulary))) {
    for (const key of [rowKey(entry.model.label), rowKey(entry.model.id)])
      if (!named.has(key))
        named.set(key, { position: entry.position, ...(entry.effort === undefined ? {} : { effort: entry.effort }) });
  }
  const groups = new Map<string, Offer[]>();
  for (const offer of facts.runtimes.flatMap(offersOf)) {
    const key = rowKey(offer.label);
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  const rows = [...groups].map(([key, group]): PackModelOption => {
    const checked = group.map((offer, index) => ({
      offer,
      index,
      refusal: runtimeRefusal(offer.runtime, offer.id, facts),
      quota: runtimeQuota(offer.runtime, facts),
    }));
    const ready = checked
      .filter(entry => entry.refusal === undefined)
      .toSorted((left, right) => headroom(left.quota, right.quota) || left.index - right.index);
    const chosen = ready[0] ?? (checked[0] as (typeof checked)[number]);
    const { offer } = chosen;
    const mention = named.get(key) ?? named.get(rowKey(offer.id));
    const effort = mention?.effort !== undefined && offer.efforts.includes(mention.effort) ? mention.effort : undefined;
    const base = {
      ...(offer.runtime.models === undefined ? {} : { provider: offer.runtime.models.catalog.id }),
      model: offer.id,
      modelLabel: offer.label,
      harness: offer.runtime.harness,
      ...(offer.tier === undefined ? {} : { tier: offer.tier }),
      efforts: [...offer.efforts],
      runtime: offer.runtime.name,
      runtimes: new Set(group.map(entry => entry.runtime.name)).size,
      quota: chosen.quota,
      ...(mention === undefined ? {} : { named: mention.position }),
      ...(effort === undefined ? {} : { effort }),
    };
    return chosen.refusal === undefined
      ? { ...base, ready: true, command: newCommand(bin, { runtime: offer.runtime.name, model: offer.id, effort }) }
      : { ...base, ready: false, refusal: chosen.refusal };
  });
  return rows.toSorted(
    (left, right) =>
      Number(right.ready) - Number(left.ready) ||
      headroom(left.quota, right.quota) ||
      (left.named ?? Number.MAX_SAFE_INTEGER) - (right.named ?? Number.MAX_SAFE_INTEGER) ||
      (left.tier === undefined ? 3 : TIER_ORDER[left.tier]) - (right.tier === undefined ? 3 : TIER_ORDER[right.tier]) ||
      left.modelLabel.localeCompare(right.modelLabel),
  );
}

/**
 * The order `fy new --auto` tries when the agent decides: the ready models the routing prompt names, in the
 * order it names them, then the ready model with the most headroom it does not name.
 */
export function automaticOrder(available: readonly PackModelOption[]): readonly PackModelOption[] {
  const ready = available.filter(option => option.ready);
  const named = ready
    .filter(option => option.named !== undefined)
    .toSorted((left, right) => (left.named ?? 0) - (right.named ?? 0));
  const fallback = ready.find(option => option.named === undefined);
  return fallback === undefined ? named : [...named, fallback];
}
