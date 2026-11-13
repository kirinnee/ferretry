/**
 * Deciding how to change the model or reasoning effort of a Codex session that is already running.
 *
 * Codex has only a modal picker for this, and the source expressed the choice as a nested `if/else` chain that
 * interleaved validation, catalog lookups, tmux reads and keystroke driving. Everything decidable is pulled out here:
 * the caller gets a plan, and IO happens only after there is one.
 *
 * Refusals are returned, not thrown. A refused switch is an ordinary answer to a request the harness cannot serve,
 * and the caller has to render it either way.
 */

/**
 * Efforts that only exist behind Codex's Advanced Reasoning submenu. Their
 * presence is what proves the quick picker will open that submenu rather than
 * applying a preset directly.
 *
 * EXPORTED BECAUSE THE DRIVER NEEDS THE SAME LIST. This module decides 'the
 * submenu will open'; the driver decides 'navigate through it'. A second copy
 * beside the driver is one fact with two owners — add a level to one and the
 * planner promises a path the driver will not take, or the driver hunts for a
 * submenu the planner said would not appear.
 */
export const ADVANCED_EFFORTS: readonly string[] = ['max', 'ultra'];

interface CodexReasoningChoice {
  readonly value: string;
}

/** One model as the live Codex account advertises it. */
interface CodexModelChoice {
  readonly value: string;
  /** The name Codex's own picker renders the model under — its `displayName`, which is not its id. */
  readonly label?: string;
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
  /** The name the picker's row carries when it is not the id (a catalog's 'DeepSeek V4 Pro'). */
  readonly rowName?: string;
  /** Absent only for a model that advertises no reasoning level: choosing its row applies it whole. */
  readonly effort?: string;
  /** The effort the quick row would apply instead of the requested one, when the
   *  account advertises it. NAMES the preset for a refusal message; it is never
   *  what decides whether to refuse — see {@link CodexPickerTarget.quickPickerAppliesPreset}. */
  readonly quickPickerDefaultEffort?: string;
  /**
   * The quick picker would apply SOME preset level for this model rather than
   * offering the requested one, and that preset is not provably the requested
   * effort.
   *
   * A SEPARATE FLAG FROM THE NAME ABOVE, because the dangerous case is precisely
   * the one with no name: an account that advertises levels and no default gives
   * a quick row whose effect nobody can predict. Deciding from the name alone
   * read that case as 'no mismatch', so the driver selected the row and the
   * daemon reported the requested level for a session running the preset one.
   */
  readonly quickPickerAppliesPreset?: true;
}

export interface HarnessRuntimeSwitchRequest {
  readonly model?: string;
  readonly effort?: string;
  /** Turn fast mode on or off. A switch of its own: it is never combined with a model or an effort. */
  readonly fast?: boolean;
}

/** What the planner needs to know about fast mode for the model a session is running. */
export interface FastModeFacts {
  /** Whether that model offers fast mode. Absent when nothing can say, which plans as 'try it'. */
  readonly supported?: boolean;
  /** What the refusal calls the model: its label, else its id. */
  readonly model?: string;
  /** Whether fast mode is on right now — the harness's report, else the launch's, else the model's default. */
  readonly current?: boolean;
}

export interface HarnessRuntimeSwitchContext {
  /** The live catalog Codex advertised, which its picker renders. */
  readonly catalog?: CodexModelCatalog;
  /** Fast mode facts for a fast request. */
  readonly fast?: FastModeFacts;
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
      readonly requestedFast?: boolean;
      readonly claimsOutcome: boolean;
    }
  /**
   * Nothing to type: the session already is in the state asked for. A harness whose switch only flips
   * can never be asked to 'turn it on' twice without turning it off again.
   */
  | { readonly kind: 'unchanged' }
  /**
   * Drive the modal picker to an exact model and effort, then verify.
   *
   * THERE IS NO 'SHOULD THE DRIVER PREFLIGHT' FLAG, and its absence is the
   * decision. This plan used to carry `needsPreflight`, set exactly when the
   * quick picker would apply a preset effort — but the driver opens and parses
   * the real screen before selecting anything either way, so the flag chose
   * between two identical behaviours while reading like a safety switch. The
   * guarantee now lives where it is enforced: {@link CodexModelPickerDriver.drive}
   * preflights unconditionally, and a caller cannot opt out. What this plan does
   * carry is the evidence that preflight JUDGES — `quickPickerAppliesPreset` and
   * the preset's name — because those are facts about the account, not about
   * whether to look.
   */
  | { readonly kind: 'drive_picker'; readonly target: CodexPickerTarget }
  /** The request cannot be served. */
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): RuntimeSwitchPlan => ({ kind: 'refused', reason });

const TARGETED_SWITCH_NEEDS_BOTH = 'a targeted switch on this harness requires both a model and a reasoning effort';

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
 * The preset verdict is where the source had a hole: it computed the mismatch as
 * `defaultReasoningEffort !== requestedEffort`, which for a model whose default
 * the account does not advertise yields `undefined`, so the target was marked
 * safe and the driver selected a quick row that could apply an unknown effort.
 * An unknown default is not a match — it is precisely the case nobody can
 * predict — so it is marked {@link CodexPickerTarget.quickPickerAppliesPreset}
 * and the driver refuses it against the real screen.
 */
function planCodexSwitch(
  model: string,
  effort: string | undefined,
  catalog: CodexModelCatalog | undefined,
): RuntimeSwitchPlan {
  if (catalog === undefined) return refused('the live Codex model catalog must be read before a targeted switch');
  const advertised = catalog.choices.find(choice => choice.value === model);
  if (advertised === undefined) return refused(`model ${model} is not in this Codex account's current catalog`);
  const rowName = advertised.label === undefined || advertised.label === model ? {} : { rowName: advertised.label };
  if (effort === undefined) {
    // A model with no level to choose is applied whole by its row; one that has levels needs the one wanted.
    return advertised.reasoningEfforts.length === 0
      ? { kind: 'drive_picker', target: { model, ...rowName } }
      : refused(TARGETED_SWITCH_NEEDS_BOTH);
  }
  if (!advertised.reasoningEfforts.some(choice => choice.value === effort)) {
    return refused(`${effort} is not advertised for Codex model ${model}`);
  }
  const quickPickerApplies = !opensReasoningMenu(advertised);
  const defaultEffort = advertised.defaultReasoningEffort;
  // The quick row is only safe when it provably applies the very effort asked for. An unknown default
  // is NOT a match — it is the case where reading the real screen matters most.
  const presetWouldWin = quickPickerApplies && defaultEffort !== effort;
  return {
    kind: 'drive_picker',
    target: {
      model,
      ...rowName,
      effort,
      ...(presetWouldWin && defaultEffort !== undefined ? { quickPickerDefaultEffort: defaultEffort } : {}),
      ...(presetWouldWin ? { quickPickerAppliesPreset: true as const } : {}),
    },
  };
}

/**
 * Plan a fast mode switch.
 *
 * Refused on a model with no fast mode before a key is pressed: Codex answers `/fast` on such a model
 * with 'Unrecognized command' and leaves the text sitting in the composer, where the next message
 * would be typed after it.
 */
function planFastSwitch(wanted: boolean, facts: FastModeFacts | undefined): RuntimeSwitchPlan {
  if (facts?.supported === false) return refused(`${facts.model ?? 'this model'} has no fast mode`);
  if (facts?.current === undefined)
    return refused('whether fast mode is on is not known yet; send a message first, or switch it in the terminal');
  if (facts.current === wanted) return { kind: 'unchanged' };
  return { kind: 'inject', command: '/fast', requestedFast: wanted, claimsOutcome: true };
}

/**
 * Plan a runtime model or effort switch.
 *
 * A blank string is treated as absent throughout: the source compared untrimmed
 * request fields in some places and trimmed ones in others, so `--model '  '`
 * reached a catalog lookup as a real name.
 */
export function planRuntimeSwitch(
  request: HarnessRuntimeSwitchRequest,
  context: HarnessRuntimeSwitchContext,
): RuntimeSwitchPlan {
  const model = request.model?.trim();
  const effort = request.effort?.trim();
  const wantsModel = model !== undefined && model.length > 0;
  const wantsEffort = effort !== undefined && effort.length > 0;

  if (request.fast !== undefined) {
    if (wantsModel || wantsEffort)
      return refused('fast mode is switched on its own, not together with a model or effort');
    return planFastSwitch(request.fast, context.fast);
  }

  // Effort alone has no command on Codex (CODEX_QUIRKS.effortIsRuntimeCommand is false): it is only settable inside
  // the picker, together with a model.
  if (wantsEffort && !wantsModel)
    return refused(
      'this harness sets reasoning effort only inside its own picker; request a model and an effort together',
    );

  // With nothing requested, open the picker and let the human
  // choose — and claim nothing about the outcome, because the daemon did not make
  // it.
  if (!wantsModel && !wantsEffort) return { kind: 'inject', command: '/model', claimsOutcome: false };
  if (!wantsModel) return refused(TARGETED_SWITCH_NEEDS_BOTH);
  return planCodexSwitch(model, wantsEffort ? effort : undefined, context.catalog);
}
