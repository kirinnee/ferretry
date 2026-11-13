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

/**
 * The `start.decide` answer for a start that asks for fast mode: refuse it, with the code Ferrets maps to `409
 * unservable_model`, when the model it NAMED has none. Only this harness's own starts, and only when fast was asked.
 * A start that named no model leaves the harness to pick one the daemon cannot see (the CLI's own default for the
 * account), so there is nothing to judge here: Claude Code answers a wrong `/fast on` itself and the switch stays
 * unconfirmed (declared in ports-pending.json).
 */
export function fastStartDecision(input: StartDecideInput): HookDecision {
  if (input.harness !== 'claude-code' || input.fast !== true || input.model === undefined) return ALLOW;
  const refusal = fastStartRefusal(input.model);
  return refusal === undefined ? ALLOW : { allow: false, reason: refusal, code: UNSERVABLE_MODEL };
}
