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

import type { RuntimeModelCatalog, RuntimeModelChoice } from './models.ts';
import type { FastModeFacts } from './runtime-switch.ts';

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
 * Only an explicit 'no' refuses. The answer is the live catalog's, which a start reads only when it asked for fast
 * mode; a model the catalog does not list, or a catalog that could not be read, is let through — the session then runs
 * on the tier it was given and its chip reports what the harness says.
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
