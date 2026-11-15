/**
 * FAST MODE: which Claude Code models have it.
 *
 * Claude Code takes `/fast on|off`, naming the state wanted. It decides support from the model's NAME: its
 * 2.1.281 gate is `opus-4-8` or `opus-5` in the id (a catalog entry's own `fast_mode` flag, when the server
 * sends one, wins inside the CLI, which the daemon cannot read). That rule is a MIRROR of the CLI's, kept here
 * once as {@link claudeFastSupport}; when a release moves it, the CLI answers a wrong `/fast on` with "Fast
 * mode unavailable", the transcript carries that answer, and the switch stays unconfirmed instead of claiming
 * a mode it did not enter.
 */

import type { StartDecideInput, StartRefusalCode } from '@ferretry/core-ferrets/contract';
import { ALLOW, type HookDecision } from '@ferretry/kernel/contract';
import type { RuntimesApi, RuntimeView } from '@ferretry/plugin-runtimes/contract';

/** The code Ferrets maps to `409 unservable_model` (its closed list; typed against it). */
const UNSERVABLE_MODEL: StartRefusalCode = 'unservable_model';

/** A model id as a harness reports it carries no `[1m]` context-window selector, so strip it before comparing. */
export const withoutSelector = (model: string): string => model.replace(/\[[^\]]*\]$/u, '');

/** Whether Claude Code 2.1.281 offers fast mode on a model, from the id alone. Sonnet and Haiku have none. */
export function claudeFastSupport(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('opus-4-8') || id.includes('opus-5');
}

/** Why a START that asks for fast mode cannot have it on the model it resolved, or nothing. */
export function fastStartRefusal(model: string): string | undefined {
  return claudeFastSupport(model) ? undefined : `${model} has no fast mode`;
}

/** The one read of Runtimes a fast start without a model needs: what the runtime it names offers. */
export type RuntimeDefaults = Pick<RuntimesApi, 'catalog'>;

/**
 * The model a runtime launches with when a start names none: the model its login's catalog defaults to (that read wins),
 * else its profile's model set's default. Absent when the runtime leaves the choice to Claude Code itself (a
 * `harness-default` set and no catalog), which the daemon cannot see.
 */
export function runtimeDefaultModel(view: RuntimeView | undefined): string | undefined {
  if (view === undefined) return undefined;
  if (view.models?.default !== undefined) return view.models.default;
  return view.modelSet.source === 'model-set' ? view.modelSet.default : undefined;
}

/**
 * The `start.decide` answer for a start that asks for fast mode: refuse it, with the code Ferrets maps to `409
 * unservable_model`, when the model it will run has none. Only this harness's own starts, and only when fast was asked.
 *
 * The model is the one the start NAMED, else the one its runtime would launch with, read through Runtimes' own contract.
 * The runtime is the one `input.runtime` NAMES, by its NAME (a runtime name is what a start carries; the catalog's `id`
 * is a persistent id that differs from it). Ferrets already resolved the machine's default runtime into `input.runtime`
 * when it launches it, and deliberately leaves it out when the start named a harness or a login, so this never reads the
 * machine's default itself: a direct login or harness start is judged on its own account, not on an unrelated default.
 * A start whose model cannot be resolved that way (no runtime, Runtimes is off, the runtime is unknown, or it leaves the
 * model to Claude Code's own account default, which the daemon cannot see) is allowed: Claude Code answers a wrong
 * `/fast on` itself and the switch stays unconfirmed (declared in ports-pending.json).
 */
export async function fastStartDecision(
  input: StartDecideInput,
  runtimes: () => RuntimeDefaults | undefined,
): Promise<HookDecision> {
  if (input.harness !== 'claude-code' || input.fast !== true) return ALLOW;
  const model = input.model ?? (await runtimeLaunchModel(input.runtime, runtimes()));
  if (model === undefined) return ALLOW;
  const refusal = fastStartRefusal(model);
  return refusal === undefined ? ALLOW : { allow: false, reason: refusal, code: UNSERVABLE_MODEL };
}

/** What the named runtime launches with, or nothing when none is named or Runtimes cannot say. */
async function runtimeLaunchModel(
  runtime: string | undefined,
  api: RuntimeDefaults | undefined,
): Promise<string | undefined> {
  if (api === undefined || runtime === undefined) return undefined;
  return runtimeDefaultModel((await api.catalog()).find(view => view.name === runtime));
}
