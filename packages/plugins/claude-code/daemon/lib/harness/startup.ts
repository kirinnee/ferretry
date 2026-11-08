import { reasoningLevel } from './launch-effort.ts';

/**
 * The model selection every new Claude Code invocation receives on its launch argv. Putting the resolved
 * choice LAST makes the daemon's explicit model decision win over an account default or a carried flag. The
 * value itself remains owned by the runtime catalogue; this helper owns only how an already validated choice
 * reaches a new invocation.
 */
export function startupModelArguments(model: string): readonly string[] {
  return ['--model', model];
}

/** A runtime command typed before turn one (the only one a Claude start needs). */
interface StartupRuntimeCommand {
  readonly action: 'effort';
  readonly effort: string;
}

/** What a start does about its reasoning level: refuse, or launch with these. */
export type StartupEffortPlan =
  | {
      readonly kind: 'refused';
      /** `invalid` — the level is not a reasoning level at all (`x_high`): a malformed request, not a model. */
      readonly cause: 'invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'planned';
      /** The runtime command to apply before turn one. */
      readonly startupRuntime?: StartupRuntimeCommand;
    };

/**
 * The whole decision of how a start carries `effort`, with nothing read or typed.
 *
 * Claude keeps `/effort` here: it is a command Claude answers locally, it opens no picker, and its start has
 * never been seen to lose one. No level plans nothing; a level `reasoningLevel` rejects (`x_high`, `9`,
 * `two words`) is refused, not dropped — a start that silently ran at the default would answer a question
 * nobody asked. Blank is no ask.
 */
export function planStartupEffort(effort: string | undefined): StartupEffortPlan {
  const level = reasoningLevel(effort);
  if (level !== undefined) return { kind: 'planned', startupRuntime: { action: 'effort', effort: level } };
  const asked = effort?.trim() ?? '';
  return asked === ''
    ? { kind: 'planned' }
    : { kind: 'refused', cause: 'invalid', reason: `${asked} is not a reasoning level` };
}
