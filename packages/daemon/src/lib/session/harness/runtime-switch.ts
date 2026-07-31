/**
 * Deciding how to change the model or reasoning effort of a session that is
 * already running.
 *
 * The two harnesses answer this completely differently — one takes a slash
 * command, the other only has a modal picker — and the source expressed that as
 * a nested `if/else` chain that interleaved validation, catalog lookups, tmux
 * reads and keystroke driving. Everything decidable is pulled out here: the
 * caller gets a plan, and IO happens only after there is one.
 *
 * Refusals are returned, not thrown. A refused switch is an ordinary answer to a
 * request the harness cannot serve, and the caller has to render it either way.
 */

import type { HarnessKind } from '../../core/inventory.ts';
import { harnessQuirks } from './quirks.ts';

/** Reasoning levels a harness with a native effort command accepts. */
export const RUNTIME_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh'];

/** Efforts that only exist behind Codex's Advanced Reasoning submenu. Their
 *  presence is what proves the quick picker will open that submenu rather than
 *  applying a preset directly. */
const ADVANCED_EFFORTS: readonly string[] = ['max', 'ultra'];

export interface CodexReasoningChoice {
  readonly value: string;
}

/** One model as the live Codex account advertises it. */
export interface CodexModelChoice {
  readonly value: string;
  readonly reasoningEfforts: readonly CodexReasoningChoice[];
  /** The effort the quick picker applies when a row is chosen directly. Absent
   *  when the account does not advertise one. */
  readonly defaultReasoningEffort?: string;
}

export interface CodexModelCatalog {
  readonly choices: readonly CodexModelChoice[];
}

/** What the picker driver has to reach. */
export interface CodexPickerTarget {
  readonly model: string;
  readonly effort: string;
  /** The effort the quick row would apply instead of the requested one, when the
   *  account advertises it. Informational for the driver's own logging; the
   *  decision to preflight is `needsPreflight`. */
  readonly quickPickerDefaultEffort?: string;
}

export interface HarnessRuntimeSwitchRequest {
  readonly harness: HarnessKind;
  readonly model?: string;
  readonly effort?: string;
}

export interface HarnessRuntimeSwitchContext {
  /** Models the wrapper permits mid-session, for a harness that switches by
   *  command. An empty list means the wrapper supports no switching at all. */
  readonly allowedModels?: readonly string[];
  /** The wrapper the session runs, named in refusals so the operator knows which
   *  account could not serve the request. */
  readonly wrapper: string;
  /** The live catalog, for a harness that switches through its picker. */
  readonly catalog?: CodexModelCatalog;
}

export type RuntimeSwitchPlan =
  /**
   * Type one native command into the session. `claimsOutcome` is false for a
   * bare picker open, where the choice is a human's and the daemon must make no
   * claim about what was selected.
   */
  | {
      readonly kind: 'inject';
      readonly command: string;
      readonly requestedModel?: string;
      readonly requestedEffort?: string;
      readonly claimsOutcome: boolean;
    }
  /** Drive the modal picker to an exact model and effort, then verify. */
  | {
      readonly kind: 'drive_picker';
      readonly target: CodexPickerTarget;
      /**
       * True when the quick picker would apply a preset effort directly, so the
       * driver must read the real screen before selecting anything.
       */
      readonly needsPreflight: boolean;
    }
  /** The request cannot be served. */
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): RuntimeSwitchPlan => ({ kind: 'refused', reason });

/**
 * Whether the quick picker will open the reasoning submenu for a model.
 *
 * It only does so when the model has an advanced effort to reach; otherwise
 * choosing the row applies the model's preset effort immediately and the
 * requested effort is silently lost.
 */
function opensReasoningMenu(choice: CodexModelChoice): boolean {
  return (
    choice.reasoningEfforts.some(effort => ADVANCED_EFFORTS.includes(effort.value)) ||
    (choice.defaultReasoningEffort !== undefined && ADVANCED_EFFORTS.includes(choice.defaultReasoningEffort))
  );
}

/**
 * Plan a Codex switch, which always means driving the picker.
 *
 * The preflight decision is where the source had a hole: it computed the
 * mismatch as `defaultReasoningEffort !== requestedEffort`, which for a model
 * whose default the account does not advertise yields `undefined`, so no
 * preflight ran and the driver selected a quick row that could apply an unknown
 * effort. An unknown default is not a match — it is the case where reading the
 * real screen matters most — so it now preflights.
 */
function planCodexSwitch(model: string, effort: string, catalog: CodexModelCatalog | undefined): RuntimeSwitchPlan {
  if (catalog === undefined) return refused('the live Codex model catalog must be read before a targeted switch');
  const advertised = catalog.choices.find(choice => choice.value === model);
  if (advertised === undefined) return refused(`model ${model} is not in this Codex account's current catalog`);
  if (!advertised.reasoningEfforts.some(choice => choice.value === effort)) {
    return refused(`${effort} is not advertised for Codex model ${model}`);
  }
  const quickPickerApplies = !opensReasoningMenu(advertised);
  const defaultEffort = advertised.defaultReasoningEffort;
  return {
    kind: 'drive_picker',
    target: {
      model,
      effort,
      ...(quickPickerApplies && defaultEffort !== undefined && defaultEffort !== effort
        ? { quickPickerDefaultEffort: defaultEffort }
        : {}),
    },
    needsPreflight: quickPickerApplies && defaultEffort !== effort,
  };
}

/**
 * Plan a runtime model or effort switch.
 *
 * A blank string is treated as absent throughout: the source compared untrimmed
 * request fields in some places and trimmed ones in others, so `--model "  "`
 * reached a catalog lookup as a real name.
 */
export function planRuntimeSwitch(
  request: HarnessRuntimeSwitchRequest,
  context: HarnessRuntimeSwitchContext,
): RuntimeSwitchPlan {
  const quirks = harnessQuirks(request.harness);
  const model = request.model?.trim();
  const effort = request.effort?.trim();
  const wantsModel = model !== undefined && model.length > 0;
  const wantsEffort = effort !== undefined && effort.length > 0;

  // Effort alone, which is a different question from "which model": one harness
  // takes it as a command, the other has no way to express it outside the picker.
  if (wantsEffort && !wantsModel) {
    if (!quirks.effortIsRuntimeCommand) {
      return refused(
        'this harness sets reasoning effort only inside its own picker; request a model and an effort together',
      );
    }
    if (!RUNTIME_EFFORT_LEVELS.includes(effort)) {
      return refused(`effort must be one of ${RUNTIME_EFFORT_LEVELS.join(', ')}`);
    }
    return { kind: 'inject', command: `/effort ${effort}`, requestedEffort: effort, claimsOutcome: true };
  }

  if (!quirks.modelSwitchNeedsPicker) {
    if (!wantsModel) return refused('a model is required for a runtime switch on this harness');
    const allowed = context.allowedModels ?? [];
    if (allowed.length === 0) {
      return refused(`in-session model switching is not supported for wrapper ${context.wrapper}`);
    }
    if (!allowed.includes(model)) return refused(`model ${model} is not available on wrapper ${context.wrapper}`);
    return { kind: 'inject', command: `/model ${model}`, requestedModel: model, claimsOutcome: true };
  }

  // A picker harness. With nothing requested, open the picker and let the human
  // choose — and claim nothing about the outcome, because the daemon did not make
  // it.
  if (!wantsModel && !wantsEffort) return { kind: 'inject', command: '/model', claimsOutcome: false };
  if (!wantsModel || !wantsEffort) {
    return refused('a targeted switch on this harness requires both a model and a reasoning effort');
  }
  return planCodexSwitch(model, effort, context.catalog);
}
