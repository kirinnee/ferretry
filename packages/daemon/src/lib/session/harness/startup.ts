import type { RuntimeModelChoice } from '@ferretry/protocol';
import type { HarnessKind } from '../../core/inventory.ts';
import { harnessQuirks } from './quirks.ts';

/**
 * The model selection every new harness invocation receives on its launch argv.
 *
 * Both supported harness CLIs accept `--model <id>`. Putting the resolved choice LAST makes the
 * daemon's explicit model decision win over an account default or a carried same-harness flag. The
 * value itself remains owned by the fleet/runtime catalogue; this helper owns only how an already
 * validated choice reaches a new invocation.
 */
export function startupModelArguments(model: string): readonly string[] {
  return ['--model', model];
}

/**
 * How a START gets the reasoning level it was asked for.
 *
 * `argv` — the level rides the launch command (`effortLaunchArguments`), so the harness is born on it
 * and nothing is typed into its pane. `command` — the level is a runtime command typed before turn one.
 *
 * CODEX IS `argv`, AND MUST STAY SO. A Codex start used to apply the level by typing `/model` and
 * driving the picker the instant the composer appeared. From Codex 0.166 the composer is drawn BEFORE
 * startup has finished — startup waits on an `account/read` round trip to chatgpt.com, which can take
 * up to fifteen seconds before it times out — so the `/model` landed in a harness that could not run it
 * yet: Codex parked it behind `Waiting for startup` and replayed it later, or never, and the picker
 * driver, which reads a bounded number of frames, saw an idle prompt and failed the start with "Codex
 * did not reach a model list". No observation budget fixes that, because the wait is the network's, not
 * the host's. `-c model_reasoning_effort=…` has no such window: Codex reads it as configuration before
 * it draws anything, and it is the form every relaunch already uses.
 *
 * Claude keeps `/effort` here: it is a command Claude answers locally, it opens no picker, and its
 * start has never been seen to lose one.
 */
export type StartupEffort =
  | { readonly kind: 'argv'; readonly effort: string }
  | { readonly kind: 'command'; readonly effort: string };

/** The way this harness's start carries `effort`, or `undefined` when none was asked for. */
export function startupEffort(harness: HarnessKind, effort: string | undefined): StartupEffort | undefined {
  const level = effort?.trim();
  if (level === undefined || level.length === 0) return undefined;
  return harnessQuirks(harness).effortIsRuntimeCommand
    ? { kind: 'command', effort: level }
    : { kind: 'argv', effort: level };
}

/**
 * Why a Codex START cannot be launched at `effort` on `model`, or `undefined` when it can.
 *
 * The same three refusals the picker drive made, made BEFORE a pane exists instead of after it: a
 * level on the argv is not checked by anybody else, and a level the model does not take would only
 * surface as a failed first turn. `choices` is the login's live catalog (its app-server's
 * `model/list`); `undefined` means it could not be read, which refuses — exactly as the picker drive
 * did — because nothing then says the level is real.
 */
export function codexStartupEffortRefusal(
  model: string,
  effort: string,
  choices: readonly RuntimeModelChoice[] | undefined,
): string | undefined {
  if (choices === undefined)
    return `the Codex model catalog could not be read, so reasoning level ${effort} cannot be checked for ${model}`;
  const advertised = choices.find(choice => choice.value === model);
  if (advertised === undefined) return `model ${model} is not in this Codex login's current catalog`;
  if (!advertised.reasoningEfforts.some(choice => choice.value === effort))
    return `${effort} is not advertised for Codex model ${model}`;
  return undefined;
}
