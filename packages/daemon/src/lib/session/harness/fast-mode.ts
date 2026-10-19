/**
 * FAST MODE: which models have it, and whether a session is running it.
 *
 * Both harnesses have a fast mode and neither lets Ferretry ask for it by name on a running session:
 * Claude Code takes `/fast on|off`, Codex's `/fast` only FLIPS between its two service tiers. What the
 * daemon can own is the facts those commands need — does the model in force offer it, and is it on
 * right now — read from records that already exist, so nothing is typed at a model that would answer
 * the command with an error.
 *
 * WHO OWNS WHICH FACT.
 *
 *   * Codex says it per model, live: the app-server lists the service tiers a model can run at, and
 *     `/fast` moves between the default tier and the one named `priority`. That is parsed into the
 *     catalog by `codex-app-server.ts`, and this module only reads the catalog.
 *   * Claude Code decides it from the model's NAME. Its 2.1.281 gate is `opus-4-8` or `opus-5` in the
 *     id (a catalog entry's own `fast_mode` flag, when the server sends one, wins inside the CLI, which
 *     the daemon cannot read). That rule is a MIRROR of the CLI's, kept here once as
 *     {@link claudeFastSupport}; when a release moves it, the CLI answers a wrong `/fast on` with
 *     "Fast mode unavailable", the transcript carries that answer, and the switch stays unconfirmed
 *     instead of claiming a mode it did not enter.
 *
 * IS IT ON. The harness's own report wins (`observedFast`), then what the session was LAUNCHED with
 * (`launchFast`), then what the model does by default. A Codex session that has taken no turn and
 * whose home configuration names a service tier of its own is assumed to be on the model's default; that
 * is a declared gap (docs/fast-mode.md).
 */

import type { RuntimeModelCatalog, RuntimeModelChoice, SessionView } from '@ferretry/protocol';
import type { HarnessKind } from '../../core/inventory.ts';
import type { FastModeFacts } from './runtime-switch.ts';

/** A model id as a harness reports it carries no `[1m]` context-window selector, so strip both before comparing. */
const withoutSelector = (model: string): string => model.replace(/\[[^\]]*\]$/u, '');

/**
 * Whether Claude Code 2.1.281 offers fast mode on a model, from the id alone: `opus-4-8` or `opus-5`
 * anywhere in it, in either case. Sonnet and Haiku have none.
 */
export function claudeFastSupport(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('opus-4-8') || id.includes('opus-5');
}

/** The catalog entry for a model, ignoring the selector a harness drops. */
export function catalogChoice(catalog: RuntimeModelCatalog, model: string | undefined): RuntimeModelChoice | undefined {
  if (model === undefined) return undefined;
  const wanted = withoutSelector(model);
  return catalog.choices.find(choice => withoutSelector(choice.value) === wanted);
}

/** The model a session is running: what the harness reported, else what it was launched on. */
export const modelInForce = (view: SessionView): string | undefined => view.state.observedModel ?? view.config.model;

/**
 * Whether fast mode is on for a session right now, as best the documents say. Absent when the model is
 * unknown to the catalog and nothing else says.
 */
export function fastInForce(view: SessionView, choice: RuntimeModelChoice | undefined): boolean | undefined {
  const known = view.state.observedFast ?? view.config.launchFast;
  if (known !== undefined) return known;
  if (choice === undefined) return undefined;
  return choice.fast === true ? choice.fastDefault === true : false;
}

/**
 * Why a START that asks for fast mode cannot have it on the model it resolved, or nothing.
 *
 * Only an explicit "no" refuses. Claude's answer is the name rule. Codex's is the live catalog's, which
 * a start reads only when it asked for fast mode; a model the catalog does not list, or a catalog that
 * could not be read, is let through — the session then runs on the tier it was given and its chip
 * reports what the harness says.
 */
export function fastStartRefusal(
  harness: HarnessKind,
  model: string,
  choices: readonly RuntimeModelChoice[],
): string | undefined {
  if (harness === 'claude') return claudeFastSupport(model) ? undefined : `${model} has no fast mode`;
  const choice = catalogChoice({ harness, source: 'codex-app-server', choices: [...choices] }, model);
  return choice?.fast === false ? `${choice.label} has no fast mode` : undefined;
}

/** The facts the planner needs for a fast switch on this session. */
export function fastModeFacts(view: SessionView, catalog: RuntimeModelCatalog): FastModeFacts {
  const model = modelInForce(view);
  const choice = catalogChoice(catalog, model);
  const current = fastInForce(view, choice);
  return {
    ...(choice?.fast === undefined ? {} : { supported: choice.fast }),
    ...(choice?.label !== undefined || model !== undefined ? { model: choice?.label ?? (model as string) } : {}),
    ...(current === undefined ? {} : { current }),
  };
}
