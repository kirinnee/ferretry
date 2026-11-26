/**
 * FAST MODE on Codex: which models have it, and whether a session is running it.
 *
 * Codex's `/fast` only FLIPS between its two service tiers and cannot be asked for by name on a running session. What
 * the daemon can own is the facts that command needs — does the model in force offer it, and is it on right now —
 * read from records that already exist, so nothing is typed at a model that would answer the command with an error.
 *
 * WHO OWNS WHICH FACT. Codex says it per model, live: the app-server lists the service tiers a model can run at, and
 * `/fast` moves between the default tier and the one named `priority`. That is parsed into the catalog by
 * `app-server.ts`, and this module only reads the catalog.
 *
 * IS IT ON. The harness's own report wins (`observedFast`), then what the session was LAUNCHED with (`launchFast`),
 * then what the model does by default. A Codex session that has taken no turn and whose home configuration names a
 * service tier of its own is assumed to be on the model's default; that is a declared gap.
 */

import type { StartDecideInput, StartRefusalCode } from '@ferretry/core-ferrets/contract';
import { ALLOW, type HookDecision } from '@ferretry/kernel/contract';
import type { RuntimeModelCatalog, RuntimeModelChoice } from './models.ts';
import type { FastModeFacts } from './runtime-switch.ts';

/** The code Ferrets maps to `409 unservable_model` (its closed list; typed against it). */
const UNSERVABLE_MODEL: StartRefusalCode = 'unservable_model';

/** The code for fast mode Codex's catalog cannot confirm for the model: the start goes on without fast (not refused) and says why. */
const FAST_UNVERIFIED: StartRefusalCode = 'fast_unverified';

/** What the owner reads at the start when fast mode was asked for and could not be confirmed. */
const startedWithoutFast = (why: string): HookDecision => ({
  allow: false,
  reason: `Started without Fast: ${why}`,
  code: FAST_UNVERIFIED,
});

/** What a session's records say about its model and fast mode (the fields the planner reads, nothing else). */
export interface FastView {
  /** What the harness last reported running. */
  readonly observedModel?: string;
  readonly observedFast?: boolean;
  /** What the session was launched with. */
  readonly launchModel?: string;
  readonly launchFast?: boolean;
}

/** A model id as a harness reports it may carry a context-window selector, so strip it before comparing. */
const withoutSelector = (model: string): string => model.replace(/\[[^\]]*\]$/u, '');

/** The catalog entry for a model, ignoring the selector a harness drops. */
export function catalogChoice(catalog: RuntimeModelCatalog, model: string | undefined): RuntimeModelChoice | undefined {
  if (model === undefined) return undefined;
  const wanted = withoutSelector(model);
  return catalog.choices.find(choice => withoutSelector(choice.value) === wanted);
}

/** The model a session is running: what the harness reported, else what it was launched on. */
export const modelInForce = (view: FastView): string | undefined => view.observedModel ?? view.launchModel;

/**
 * Whether fast mode is on for a session right now, as best the documents say. Absent when the model is unknown to the
 * catalog and nothing else says.
 */
export function fastInForce(view: FastView, choice: RuntimeModelChoice | undefined): boolean | undefined {
  const known = view.observedFast ?? view.launchFast;
  if (known !== undefined) return known;
  if (choice === undefined) return undefined;
  return choice.fast === true ? choice.fastDefault === true : false;
}

/**
 * Why a START that asks for fast mode cannot have it on the model it resolved, or nothing.
 *
 * Fast is allowed ONLY when the held catalog lists the model AND says it has a fast tier (`fast === true`). A model the list
 * does not carry, or a row with no fast-tier evidence, is refused: fast is never allowed unverified (#35).
 */
export function fastStartRefusal(model: string, choices: readonly RuntimeModelChoice[]): string | undefined {
  const choice = catalogChoice({ harness: 'codex', source: 'codex-app-server', choices }, model);
  if (choice === undefined) return `Codex's model list does not include ${model}, so its fast mode cannot be confirmed`;
  if (choice.fast === true) return undefined;
  return choice.fast === false
    ? `${choice.label} has no fast mode`
    : `Codex's model list does not say ${choice.label} has fast mode, so it cannot be confirmed`;
}

/**
 * Whether a LAUNCH may carry the paid priority tier: the model it will run (the one named, else the held list's default)
 * is listed WITH a fast tier. The same rule a start is judged on ({@link fastStartRefusal}), asked again at the argv, so a
 * relaunch whose model changed, or whose list is gone, never passes a tier nobody verified (#35).
 */
export function fastLaunchVerified(
  model: string | undefined,
  choices: readonly RuntimeModelChoice[] | undefined,
): boolean {
  if (choices === undefined) return false;
  const run = model ?? choices.find(choice => choice.isDefault === true)?.value;
  return run !== undefined && fastStartRefusal(run, choices) === undefined;
}

/** The facts the planner needs for a fast switch on this session. */
export function fastModeFacts(view: FastView, catalog: RuntimeModelCatalog): FastModeFacts {
  const model = modelInForce(view);
  const choice = catalogChoice(catalog, model);
  const current = fastInForce(view, choice);
  return {
    ...(choice?.fast === undefined ? {} : { supported: choice.fast }),
    ...(choice?.label !== undefined || model !== undefined ? { model: choice?.label ?? (model as string) } : {}),
    ...(current === undefined ? {} : { current }),
  };
}

/**
 * What a fast start is told while no catalog is in hand (never loaded from disk, never read). The first read of a machine's
 * first boot starts a few seconds after the daemon serves and takes about a second (O8-4), so that is what the sentence
 * promises.
 */
export const CATALOG_LOADING = "Codex's model list is still loading; try again in a few seconds";

/**
 * What a fast start is told for a model Ferretry's `openai` catalog lists while Codex's own list has not been read: fast
 * mode is not confirmed yet, the read is retried by itself, and a start without fast works now.
 */
export const FAST_NOT_CONFIRMED = (label: string, retryInMs = 0): string => {
  const minutes = Math.ceil(retryInMs / 60_000);
  const when = minutes > 0 ? `the next read is in about ${minutes} min` : 'it is read again on the next fast start';
  return `Fast mode for ${label} is not confirmed yet (Codex's model list could not be read; ${when})`;
};

/** What a fast start is told when it names no model and the held list has no default to judge it on. */
export const NO_MODEL_FOR_FAST =
  "Codex's model list names no default model, so fast mode cannot be confirmed; pick a model";

/** What a fast start is told when the read looked for Codex and it is not there: it will not load, so it does not say so. */
export const CODEX_NOT_FOUND = 'Codex could not be found, so its fast mode cannot be checked';

/**
 * The models the `openai` catalog lists for Codex, as the choices a fast start is judged against while no read of Codex's
 * own list has landed. The catalog states no service tier, so `fast` is left unset ("nobody can say"), so they never allow a fast start; the
 * refusal only uses them to say what it is refusing. Nothing when no `openai` catalog (or no codex half of it) is in effect.
 */
export function openaiFallbackChoices(view: {
  readonly catalogs: readonly {
    readonly id: string;
    readonly codex?: readonly {
      readonly id: string;
      readonly label: string;
      readonly tier: 'best' | 'balanced' | 'fast';
      readonly context?: number;
      readonly efforts: readonly string[];
      readonly default: boolean;
    }[];
  }[];
}): readonly RuntimeModelChoice[] | undefined {
  const models = view.catalogs.find(catalog => catalog.id === 'openai')?.codex;
  if (models === undefined || models.length === 0) return undefined;
  return models.map(model => ({
    value: model.id,
    label: model.label,
    tier: model.tier,
    ...(model.context === undefined ? {} : { context: model.context }),
    ...(model.default ? { isDefault: true as const } : {}),
    reasoningEfforts: model.efforts.map(value => ({ value })),
  }));
}

/**
 * The `start.decide` answer for a start that asks for fast mode. A model the live Codex catalog says has NO fast mode is refused, with
 * the code Ferrets maps to `409 unservable_model`. Fast mode that cannot be VERIFIED (no catalog held yet, no Codex binary,
 * a model the list does not carry or says nothing about) does not fail the start: the answer carries `fast_unverified` and
 * Ferrets starts the ferret without fast and shows the sentence (`Started without Fast: ...`). Fast is never passed unverified.
 * Only this harness's own starts, and only when fast was asked.
 *
 * The model is the one the start NAMED, else the catalog's own default. `held` is the catalog already in hand (a start
 * decides in the kernel's default 200 ms and never waits for a read). `undefined` means none is held: the first boot
 * ever, or no read has ever worked. With none held, the start goes on without fast, saying {@link CATALOG_LOADING} (or {@link CODEX_NOT_FOUND}
 * when the last read found no Codex binary). A catalog that is held but does not list the model, or lists it without fast-tier evidence, does the same.
 * `known` is the `openai` catalog's models ({@link openaiFallbackChoices}): they state no service tier, so they never allow
 * a start, but a refusal for a model they list says so ({@link FAST_NOT_CONFIRMED}) instead of "still loading".
 */
export function fastStartDecision(
  input: StartDecideInput,
  held: () => readonly RuntimeModelChoice[] | undefined,
  binaryMissing: () => boolean = () => false,
  known: () => readonly RuntimeModelChoice[] | undefined = () => undefined,
  retryInMs: () => number = () => 0,
): HookDecision {
  if (input.harness !== 'codex' || input.fast !== true) return ALLOW;
  const choices = held();
  if (choices === undefined) {
    if (binaryMissing()) return startedWithoutFast(CODEX_NOT_FOUND);
    const listed = known();
    const model = input.model ?? listed?.find(choice => choice.isDefault === true)?.value;
    const entry =
      model === undefined
        ? undefined
        : catalogChoice({ harness: 'codex', source: 'codex-app-server', choices: listed ?? [] }, model);
    return startedWithoutFast(entry === undefined ? CATALOG_LOADING : FAST_NOT_CONFIRMED(entry.label, retryInMs()));
  }
  const model = input.model ?? choices.find(choice => choice.isDefault === true)?.value;
  if (model === undefined) return startedWithoutFast(NO_MODEL_FOR_FAST);
  const refusal = fastStartRefusal(model, choices);
  if (refusal === undefined) return ALLOW;
  // A model the list says has NO fast mode is a definite no (refused); one it cannot confirm goes on without fast.
  return catalogChoice({ harness: 'codex', source: 'codex-app-server', choices }, model)?.fast === false
    ? { allow: false, reason: refusal, code: UNSERVABLE_MODEL }
    : startedWithoutFast(refusal);
}
