import type { RuntimeControlRequest, RuntimeModelChoice } from '@ferretry/protocol';
import type { HarnessKind } from '../../core/inventory.ts';
import { reasoningLevel } from './launch-effort.ts';
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
 * That is a NEW session's start (`fy new`, the app's New ferret). A FORK still applies its target's model
 * and effort through the startup picker hook, and that drive tolerates a slow startup because frames
 * showing Codex's `Waiting for startup` line are not charged to its budget (`CODEX_STARTUP_WAIT_OBSERVATIONS`).
 *
 * Claude keeps `/effort` here: it is a command Claude answers locally, it opens no picker, and its
 * start has never been seen to lose one.
 */
export type StartupEffort =
  | { readonly kind: 'argv'; readonly effort: string }
  | { readonly kind: 'command'; readonly effort: string };

/**
 * The way this harness's start carries `effort`, or `undefined` when none was asked for.
 *
 * The level goes through `reasoningLevel`, the very normaliser `launchReasoningEffort` records the document's
 * level with, so the level on the argv and the level the session records can never differ — and a level that
 * normaliser rejects (`x_high`, `9`) is carried as none, exactly as the document records none for it. An `argv`
 * answer also tells the caller it must read the login's catalog before `planStartupEffort`.
 */
export function startupEffort(harness: HarnessKind, effort: string | undefined): StartupEffort | undefined {
  const level = reasoningLevel(effort);
  if (level === undefined) return undefined;
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
 * `model/list`); an `Error` is the probe's own failure and `undefined` that it was not read at all — both
 * refuse, exactly as the picker drive did, because nothing then says the level is real. The probe's message
 * is put in the refusal so the person sees WHY, and the remedy is named.
 */
export function codexStartupEffortRefusal(
  model: string,
  effort: string,
  choices: readonly RuntimeModelChoice[] | Error | undefined,
): string | undefined {
  if (choices === undefined || choices instanceof Error) {
    const why = choices === undefined || choices.message.trim() === '' ? '' : ` (${choices.message.trim()})`;
    return `the Codex model catalog could not be read${why}, so reasoning level ${effort} cannot be checked for ${model}; retry, or start without --effort`;
  }
  const advertised = choices.find(choice => choice.value === model);
  if (advertised === undefined) return `model ${model} is not in this Codex login's current catalog`;
  if (!advertised.reasoningEfforts.some(choice => choice.value === effort))
    return `${effort} is not advertised for Codex model ${model}`;
  return undefined;
}

/** What a start does about its reasoning level: refuse, or launch with these. */
export type StartupEffortPlan =
  | {
      readonly kind: 'refused';
      /**
       * `catalog_unreadable` — the login's catalog could not be read, so nothing was decided: a RETRY may
       * succeed. `unservable` — the catalog was read and does not list the model or the level: it will not.
       */
      readonly cause: 'catalog_unreadable' | 'unservable';
      readonly reason: string;
    }
  | {
      readonly kind: 'planned';
      /** The level for the launch argv (Codex). */
      readonly argvEffort?: string;
      /** The runtime command to apply before turn one (Claude). */
      readonly startupRuntime?: RuntimeControlRequest;
    };

/**
 * The whole decision of how a start carries `effort`, with nothing read or typed.
 *
 * `catalog` is what the caller read for a Codex level — the login's models, or the `Error` its probe threw —
 * and is only consulted for an `argv` start (`startupEffort` says whether the caller must read it). No level
 * plans nothing; a Codex level is checked against the catalog (`codexStartupEffortRefusal`) and then rides the
 * argv; a Claude level becomes an `effort` runtime command.
 */
export function planStartupEffort(
  harness: HarnessKind,
  model: string,
  effort: string | undefined,
  catalog: readonly RuntimeModelChoice[] | Error | undefined,
): StartupEffortPlan {
  const carried = startupEffort(harness, effort);
  if (carried === undefined) return { kind: 'planned' };
  if (carried.kind === 'command')
    return { kind: 'planned', startupRuntime: { action: 'effort', effort: carried.effort } };
  const reason = codexStartupEffortRefusal(model, carried.effort, catalog);
  if (reason === undefined) return { kind: 'planned', argvEffort: carried.effort };
  return {
    kind: 'refused',
    cause: catalog === undefined || catalog instanceof Error ? 'catalog_unreadable' : 'unservable',
    reason,
  };
}
