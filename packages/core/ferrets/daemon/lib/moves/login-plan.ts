import type { RuntimeModelCatalog } from '../../../contract/view/runtime-control.ts';
import type { SessionConfig, SessionState } from '../protocol/session.ts';
import { currentLaunchEffort, type LaunchModelSource, movedModel, movedModelSource } from '../session/launch/index.ts';

/**
 * WHAT A MOVE ONTO ANOTHER LOGIN OF THE SAME HARNESS RUNS ON — decided from reads alone, and pure.
 *
 * The one place that answers "which model does the ferret land on, in which window, at which effort, or why not". It is the
 * 5.0 successor of v4's `SessionPlanner` subset a move used, over what Runtimes publishes (`runtime.start`'s `catalog?`)
 * instead of the fleet manifest's accounts:
 *
 *   * A model the request names is served by the target or the move is refused (`unservable_model`), never quietly landed
 *     on the target's default: that would move a live conversation into another model and window while the answer named
 *     the one asked for.
 *   * A request that names none KEEPS the model the ferret is on when the target serves it, and only when a person picked it
 *     (`movedModel`): a model that was only the source runtime's default must not follow the ferret onto a runtime with its
 *     own. Where the target cannot serve it, the target's default decides, as a start would.
 *   * A smaller window is refused unless the caller accepted it (`context_downgrade`), with both windows as data. A window
 *     either side does not state is not a downgrade: nothing is cut off on a guess.
 *   * The effort goes with the ferret when the target's model takes it; otherwise it starts on its login's own setting
 *     (effort vocabularies differ between models and harnesses), which a launch with no effort is.
 *
 * Nothing here reads the host, a document or a plugin: the caller hands over the two catalogues.
 */

/** A `[1m]`-style selector, which the harness is handed with a model but a catalogue never lists. */
const SELECTOR = /\[[^\]]*\]$/u;

type Choice = RuntimeModelCatalog['choices'][number];

/** The catalogue entry a model id names, with or without the selector a ferret records it with. */
function served(catalog: RuntimeModelCatalog | undefined, model: string | undefined): Choice | undefined {
  if (catalog === undefined || model === undefined) return undefined;
  const bare = model.replace(SELECTOR, '');
  return catalog.choices.find(entry => entry.value === model) ?? catalog.choices.find(entry => entry.value === bare);
}

/** The model a runtime launches with when none is named, when it is servable. */
const defaultChoice = (catalog: RuntimeModelCatalog | undefined): Choice | undefined =>
  catalog?.choices.find(entry => entry.isDefault === true);

export interface LoginPlanRequest {
  readonly config: SessionConfig;
  readonly state: SessionState;
  /** The model the request named, if any. */
  readonly requestedModel: string | undefined;
  /** The caller accepts a smaller window (part of the conversation may be cut off). */
  readonly allowContextDowngrade: boolean;
  /** What the runtime the ferret is on serves; `undefined` when it cannot say (its window then comes from the state alone). */
  readonly source: RuntimeModelCatalog | undefined;
  readonly target: RuntimeModelCatalog;
}

/** What a move onto another login came to. A refusal is a planning outcome, not an exception. */
export type LoginPlan =
  | {
      readonly kind: 'planned';
      /** The model the relaunch runs; absent leaves the choice to the target's own default (a runtime that names none). */
      readonly model: string | undefined;
      /** Who chose it, as the session document records it. */
      readonly modelSource: LaunchModelSource;
      /** The effort the relaunch runs on; absent is the target login's own setting. */
      readonly effort: string | undefined;
      /** Whether the ferret's own model was kept (rather than the target's default or the one named). */
      readonly kept: boolean;
    }
  | { readonly kind: 'unservable_model'; readonly reason: string }
  | {
      readonly kind: 'context_downgrade';
      readonly reason: string;
      readonly downgrade: { readonly model: string; readonly targetWindow: number; readonly currentWindow: number };
    };

/** The window this ferret is running in now: the harness's own report, else what the runtime it is on declares for its model. */
function currentWindow(request: LoginPlanRequest): number | undefined {
  const { config, state, source } = request;
  if (state.contextWindow !== undefined) return state.contextWindow;
  const model = state.observedModel ?? config.model ?? defaultChoice(source)?.value;
  return served(source, model)?.context;
}

export function planLoginMove(request: LoginPlanRequest): LoginPlan {
  const { config, state, requestedModel, target } = request;
  const customIds = target.catalog?.customIds === true;
  const offered = target.choices.map(entry => entry.value).join(', ');

  if (requestedModel !== undefined && served(target, requestedModel) === undefined && !customIds)
    return {
      kind: 'unservable_model',
      reason:
        target.choices.length === 0
          ? `this runtime names no models of its own, so ${requestedModel} cannot be asked of it. Move without --model to run on its default.`
          : `this runtime does not serve ${requestedModel}. It serves: ${offered}. Nothing was changed.`,
    };

  const sourceDefault = defaultChoice(request.source)?.value;
  const keep =
    requestedModel === undefined
      ? movedModel({
          config,
          state,
          sourceDefault,
          crossing: { sameRuntime: false },
          servable: model => served(target, model) !== undefined,
        })
      : undefined;
  // A model kept only when the target serves it: the target's default decides otherwise, as a start does.
  const kept = keep !== undefined && served(target, keep) !== undefined ? keep : undefined;
  const model = requestedModel ?? kept ?? defaultChoice(target)?.value;
  const modelSource: LaunchModelSource =
    model === undefined
      ? 'account-default'
      : movedModelSource({
          config,
          sourceDefault,
          named: requestedModel !== undefined,
          kept: kept !== undefined,
          model,
        });

  const chosen = served(target, model) ?? defaultChoice(target);
  const targetWindow = chosen?.context;
  const window = currentWindow(request);
  if (targetWindow !== undefined && window !== undefined && targetWindow < window && !request.allowContextDowngrade)
    return {
      kind: 'context_downgrade',
      reason:
        `the target serves ${model ?? 'its default model'} with a ${targetWindow}-token window and this ferret is ` +
        `running in ${window}, so part of this conversation would be cut off. ` +
        'Re-run with --allow-context-downgrade to accept that.',
      downgrade: { model: model ?? chosen?.value ?? '', targetWindow, currentWindow: window },
    };

  // An effort goes only where the target's model is known to take it; a catalogue that lists none for the model says it takes none.
  const carried = currentLaunchEffort(config, state);
  const informative = chosen !== undefined && (target.catalog !== undefined || chosen.reasoningEfforts.length > 0);
  const effort =
    carried === undefined || (informative && !chosen.reasoningEfforts.some(entry => entry.value === carried))
      ? undefined
      : carried;
  return { kind: 'planned', model, modelSource, effort, kept: kept !== undefined };
}
