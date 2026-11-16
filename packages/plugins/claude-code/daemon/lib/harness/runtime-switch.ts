/**
 * LIVE MODEL, EFFORT AND FAST-MODE SWITCH of a RUNNING Claude Code ferret (`Harness.runtimeSwitch`): the part only this
 * harness knows. Ferrets owns the control (who may, the one-at-a-time queue, the replay ledger, the pane checks, the
 * refusal taxonomy); this file owns what Claude Code is asked and what it offers.
 *
 * CLAUDE SWITCHES BY COMMAND. `/model <id>`, `/effort <level>` and `/fast on|off` are typed into the idle pane, and
 * Claude Code applies them itself. There is no picker to drive, so nothing here can leave a modal open: a drive that
 * "failed part-way" does not exist on this harness, and recovery has nothing to undo.
 *
 * NO MODEL IS GUESSED. A model must be one the ferret's account serves (the catalog its runtime published), or any
 * well-formed id when that catalog takes custom ids. A model and an effort are two commands, and a plan is one, so asking
 * for both is refused rather than applying the first and silently dropping the second.
 */
import type {
  FastModeFacts,
  FerretView,
  HarnessQuirkService,
  HarnessRuntimeSwitch,
  HarnessRuntimeSwitchContext,
  HarnessRuntimeSwitchRequest,
  PickerRecovery,
  RuntimeModelCatalog,
  RuntimeModelChoice,
  RuntimeSwitchAccount,
  RuntimeSwitchPlan,
} from '@ferretry/core-ferrets/contract';
import { claudeFastSupport, withoutSelector } from './fast-mode.ts';

/** The efforts Claude Code's `/effort` takes. */
export const RUNTIME_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A model id a person typed ("Custom id…"), as one word the pane can take after `/model`: no whitespace, no control
 * character, nothing a terminal reads as a command. The model catalog's own grammar.
 */
const CUSTOM_MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}(?:\[[a-z0-9]{1,8}\])?$/u;

const refused = (reason: string): RuntimeSwitchPlan => ({ kind: 'refused', reason });

/** How to change the model, effort or fast mode of a live Claude Code session. */
export function planClaudeSwitch(
  request: HarnessRuntimeSwitchRequest,
  context: HarnessRuntimeSwitchContext,
): RuntimeSwitchPlan {
  // A blank string is absent: `--model "  "` must not reach a lookup as a real name.
  const model = request.model?.trim();
  const effort = request.effort?.trim();
  const wantsModel = model !== undefined && model.length > 0;
  const wantsEffort = effort !== undefined && effort.length > 0;

  if (request.fast !== undefined) {
    if (wantsModel || wantsEffort)
      return refused('fast mode is switched on its own, not together with a model or effort');
    // Refused before a key is pressed: Claude Code answers `/fast` on a model with none with "Fast mode unavailable".
    if (context.fast?.supported === false) return refused(`${context.fast.model ?? 'this model'} has no fast mode`);
    return {
      kind: 'inject',
      command: `/fast ${request.fast ? 'on' : 'off'}`,
      requestedFast: request.fast,
      claimsOutcome: true,
    };
  }

  if (wantsModel && wantsEffort)
    return refused(
      'a model and an effort are switched one at a time on this harness: switch the model, then the effort',
    );

  if (wantsEffort) {
    if (!RUNTIME_EFFORT_LEVELS.includes(effort)) {
      return refused(`effort must be one of ${RUNTIME_EFFORT_LEVELS.join(', ')}`);
    }
    return { kind: 'inject', command: `/effort ${effort}`, requestedEffort: effort, claimsOutcome: true };
  }

  if (!wantsModel) return refused('a model is required for a runtime switch on this harness');
  const allowed = context.allowedModels ?? [];
  if (allowed.length === 0)
    return refused(`in-session model switching is not supported for wrapper ${context.wrapper}`);
  if (!allowed.includes(model) && !(context.acceptsCustomModels === true && CUSTOM_MODEL_ID.test(model))) {
    return refused(`model ${model} is not available on wrapper ${context.wrapper}`);
  }
  return { kind: 'inject', command: `/model ${model}`, requestedModel: model, claimsOutcome: true };
}

/** The catalog a Claude session may be switched within: the models its account serves, as its picker would list them. */
export function claudeRuntimeCatalog(account: RuntimeSwitchAccount): RuntimeModelCatalog {
  const serves = account.available ? account.models.filter(model => model.available) : [];
  return {
    harness: 'claude',
    source: 'wrapper-inventory',
    choices: serves.map(model => ({
      value: model.id,
      label: model.displayName ?? model.id,
      ...(model.tier === undefined ? {} : { tier: model.tier }),
      ...(model.context === undefined ? {} : { context: model.context }),
      fast: claudeFastSupport(model.id),
      ...(account.defaultModel === model.id ? { isDefault: true as const } : {}),
      reasoningEfforts: (model.efforts ?? []).map(value => ({ value })),
      ...(model.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.defaultEffort }),
    })),
    ...(account.modelCatalog === undefined ? {} : { catalog: { ...account.modelCatalog } }),
  };
}

/** The model a session is running and what it said about fast mode, flat: the planner reads these, not the documents. */
function modelInForce(view: FerretView): string | undefined {
  return view.state.observedModel ?? view.config.model;
}

/**
 * The facts a fast switch needs: whether the model has it, and what to call the model in a refusal. Whether it is on now
 * is not asked: `/fast on|off` names the state, so it is never a toggle on this harness.
 */
export function claudeFastModeFacts(view: FerretView, catalog: RuntimeModelCatalog): FastModeFacts {
  const model = modelInForce(view);
  const wanted = model === undefined ? undefined : withoutSelector(model);
  const choice: RuntimeModelChoice | undefined =
    wanted === undefined ? undefined : catalog.choices.find(entry => withoutSelector(entry.value) === wanted);
  const supported = choice?.fast ?? (model === undefined ? undefined : claudeFastSupport(model));
  const name = choice?.label ?? model;
  return {
    ...(supported === undefined ? {} : { supported }),
    ...(name === undefined ? {} : { model: name }),
  };
}

/** Nothing to recover: no picker is ever opened, so no drive fails part-way. */
const RECOVERED: PickerRecovery = { kind: 'recovered' };

const QUIRKS: HarnessQuirkService = {
  planSwitch: planClaudeSwitch,
  recoverFromFailedDrive: async () => RECOVERED,
  // Never reached (no quarantine is ever produced here); a sentence rather than a crash if a caller asks.
  report: quarantine => quarantine.needsHuman,
};

/** What this harness offers Ferrets' runtime control. It holds nothing per ferret: the pane is the control's own. */
export const CLAUDE_RUNTIME_SWITCH: HarnessRuntimeSwitch = {
  quirks: QUIRKS,
  catalogs: { claudeRuntimeCatalog, fastModeFacts: claudeFastModeFacts },
};
