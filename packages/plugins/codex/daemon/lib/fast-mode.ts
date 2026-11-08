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
 * Only an explicit 'no' refuses. The answer is the live catalog's, which a start looks at only when it asked for fast
 * mode; a model the held catalog does not list is let through — the session then runs on the tier it was given and its
 * chip reports what the harness says. (No catalog at all is refused earlier, in {@link fastStartDecision}.)
 */
export function fastStartRefusal(model: string, choices: readonly RuntimeModelChoice[]): string | undefined {
  const choice = catalogChoice({ harness: 'codex', source: 'codex-app-server', choices }, model);
  return choice?.fast === false ? `${choice.label} has no fast mode` : undefined;
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
 * first boot waits for the kernel's worker lane, which opens about two minutes after the daemon serves, so that is what the
 * sentence promises — not seconds.
 */
export const CATALOG_LOADING = "Codex's model list is still loading; try again in about two minutes";

/** What a fast start is told when the read looked for Codex and it is not there: it will not load, so it does not say so. */
export const CODEX_NOT_FOUND = 'Codex could not be found, so its fast mode cannot be checked';

/**
 * The `start.decide` answer for a start that asks for fast mode: refuse it, with the code Ferrets maps to `409
 * unservable_model`, when the live Codex catalog says the model has none — or when there is no catalog to ask yet.
 * Only this harness's own starts, and only when fast was asked (a start that did not ask is never held up by it).
 *
 * The model is the one the start NAMED, else the catalog's own default. `held` is the catalog already in hand (a start
 * decides in the kernel's default 200 ms and never waits for a read). `undefined` means none is held: the first boot
 * ever, or no read has ever worked. Fast is never allowed unverified, so that REFUSES at once with {@link CATALOG_LOADING} (or {@link CODEX_NOT_FOUND}
 * when the last read found no Codex binary — the same closed code, still fail closed)
 * (britnee, #35). Today a cold read waited, and a failed one allowed (rebuild-ref `bin/fyd.ts:2692`, `.catch(() => [])`);
 * both are tightened on purpose. A catalog that is held but does not list the model refuses nothing, as today.
 */
export function fastStartDecision(
  input: StartDecideInput,
  held: () => readonly RuntimeModelChoice[] | undefined,
  binaryMissing: () => boolean = () => false,
): HookDecision {
  if (input.harness !== 'codex' || input.fast !== true) return ALLOW;
  const choices = held();
  if (choices === undefined)
    return { allow: false, reason: binaryMissing() ? CODEX_NOT_FOUND : CATALOG_LOADING, code: UNSERVABLE_MODEL };
  const model = input.model ?? choices.find(choice => choice.isDefault === true)?.value;
  if (model === undefined) return ALLOW;
  const refusal = fastStartRefusal(model, choices);
  return refusal === undefined ? ALLOW : { allow: false, reason: refusal, code: UNSERVABLE_MODEL };
}
