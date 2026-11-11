/**
 * The model, reasoning effort and fast mode a session is ON, which is what a relaunch must keep.
 *
 * Two records say it, and neither is enough alone:
 *
 *   * `config.model` is the daemon's DECISION — what the start, the migration or the last relaunch
 *     put on the argv. It is the only record of a `[1m]` selector, which a harness strips from what it
 *     reports.
 *   * `state.observedModel` is the harness's own REPORT, folded from its transcript. It is the only
 *     record of a switch the owner made by typing `/model` into the pane, which the daemon never sees.
 *
 * So the observation wins when it is NEWER than the decision and names a different model this
 * account can serve; otherwise the decision stands. "Newer" matters: a migration records a new
 * decision while the state still holds the old account's last observation, and that observation must
 * not drag the session back onto the model it just left.
 */

import type { CompactAt, SessionConfig, SessionState } from '@ferretry/protocol';
import { resolveCompactAt } from '../compact-at/resolve.ts';

/** A `[1m]`-style selector suffix, which a harness drops from the model it reports. */
const SELECTOR = /\[[^\]]*\]$/u;

/** The same model, give or take the selector a harness does not echo. */
const sameModel = (left: string, right: string): boolean => left.replace(SELECTOR, '') === right.replace(SELECTOR, '');

/** When the daemon last decided this session's model: its last migration, else its creation. */
const decidedAt = (config: SessionConfig): string => config.migration?.at ?? config.createdAt;

/** Whether the harness reported after the daemon last decided. */
const observedSinceDecision = (config: SessionConfig, state: SessionState): boolean =>
  state.observedModelAt !== undefined && Date.parse(state.observedModelAt) > Date.parse(decidedAt(config));

/**
 * The model a relaunch should ask for, or nothing when neither record names one — which leaves the
 * account's default in charge, exactly as a start that named none.
 */
export function currentLaunchModel(
  config: SessionConfig,
  state: SessionState,
  servable: (model: string) => boolean,
): string | undefined {
  const decided = config.model;
  const observed = state.observedModel;
  if (
    observed !== undefined &&
    observedSinceDecision(config, state) &&
    (decided === undefined || !sameModel(decided, observed)) &&
    servable(observed)
  )
    return observed;
  return decided;
}

/** What the planner reports as a model's source, narrowed to what a session document records. */
export function recordedModelSource(source: string): 'requested' | 'account-default' {
  return source === 'requested' ? 'requested' : 'account-default';
}

/**
 * The provenance a relaunch records beside the model it persists. The shared rule: the source is
 * `requested` only when the person picked the model, and `account-default` only when nobody did.
 *
 *   * the model is the decision's own (`launched` equals `config.model`): the record stands as it was;
 *   * the harness reported a newer `/model` switch that is now persisted: the person picked it, so
 *     `requested`, or the next move would see no switch and drop the pick;
 *   * the model the session was on is no longer served and the account's default replaced it: nobody
 *     picked what runs now, so `account-default`.
 */
export function relaunchedModelSource(input: {
  readonly config: Pick<SessionConfig, 'model' | 'launchModelSource'>;
  /** What `currentLaunchModel` asked the planner for. */
  readonly wanted: string | undefined;
  /** Whether the planner served `wanted`, rather than falling back to the account's default. */
  readonly served: boolean;
}): 'requested' | 'account-default' | undefined {
  const { config, wanted, served } = input;
  if (wanted === undefined) return config.launchModelSource;
  if (!served) return 'account-default';
  return wanted === config.model ? config.launchModelSource : 'requested';
}

/**
 * The provenance a MIGRATION records beside the model it persists, by the same rule as a relaunch.
 *
 * A Restart (same runtime, no model named) re-asks the model the session is on, and the planner reports
 * ANY re-asked model as `requested`, so its own source says nothing. The record therefore stands while the
 * model is unchanged. When the plan persists a DIFFERENT model, it is the planner's report that is true: the
 * harness's newer `/model` switch was re-asked and kept (`requested`), or the old model was no longer served
 * and the account's default replaced it (`account-default`). A move onto another runtime, or one that
 * names a model, records what the planner decided.
 */
export function migratedModelSource(input: {
  readonly config: Pick<SessionConfig, 'model' | 'launchModelSource'>;
  readonly restart: boolean;
  readonly planModel: string;
  readonly planSource: string;
}): 'requested' | 'account-default' | undefined {
  const { config, restart, planModel, planSource } = input;
  if (restart && planModel === config.model) return config.launchModelSource;
  return recordedModelSource(planSource);
}

/** The field a document records, or nothing when no provenance is known. */
export function optionalModelSource(
  source: 'requested' | 'account-default' | undefined,
): { launchModelSource: 'requested' | 'account-default' } | Record<string, never> {
  return source === undefined ? {} : { launchModelSource: source };
}

export interface MovedModelInput {
  readonly config: SessionConfig;
  readonly state: SessionState;
  /** The SOURCE login's default model today, when it still exists. */
  readonly sourceDefault: string | undefined;
  /** Whether the move lands on another runtime (a Restart does not). */
  readonly crossing: boolean;
  readonly servable: (model: string) => boolean;
}

/**
 * The model a MOVE should ask the target for, or nothing so the target's own default decides.
 *
 * A Restart (same runtime) keeps the model the session is on, as `currentLaunchModel` says. A move
 * onto ANOTHER runtime keeps it only when the person chose it: the session's model is otherwise just
 * the source login's default, and carrying that over would pin a session to a model its new login
 * serves only incidentally. The person chose when the harness reported a switch after the decision
 * (`/model`), when the launch recorded `requested`, or — on a document with no record — when the
 * model is not the source login's default (and when that default is unknown, the model is kept).
 */
export function movedModel(input: MovedModelInput): string | undefined {
  const { config, state, sourceDefault, crossing, servable } = input;
  const current = currentLaunchModel(config, state, servable);
  if (!crossing || current === undefined) return current;
  const switched = current !== config.model;
  const recorded = config.launchModelSource;
  const picked =
    switched ||
    recorded === 'requested' ||
    (recorded === undefined && (sourceDefault === undefined || !sameModel(current, sourceDefault)));
  return picked ? current : undefined;
}

/**
 * The fast mode a relaunch should ask for: the harness's report when it is newer than the last
 * decision, else the state the session was launched in. Absent when neither was ever decided, which
 * leaves the harness's own setting in charge — a relaunch must not turn a default into a choice.
 */
export function currentLaunchFast(config: SessionConfig, state: SessionState): boolean | undefined {
  if (state.observedFast !== undefined && observedSinceDecision(config, state)) return state.observedFast;
  return config.launchFast;
}

/**
 * Where a relaunch compacts the conversation, as a token count: the ferret's own choice, else its login's
 * default. `auto` (either said so, or neither said anything) is nothing, which leaves the harness's own
 * trigger in charge. A ferret's explicit `auto` beats a login default. A value the launch model's `window` cannot
 * honour is dropped to `auto` (`resolveCompactAt`): refusing a launch over a default would be worse.
 */
export function currentLaunchCompactAt(
  config: Pick<SessionConfig, 'compactAt'>,
  accountDefault: CompactAt | undefined,
  window: number | undefined,
): number | undefined {
  const { effective } = resolveCompactAt({ own: config.compactAt, accountDefault }, window);
  return typeof effective === 'number' ? effective : undefined;
}

/**
 * The reasoning effort a relaunch should ask for: the harness's report when it is newer than the
 * last decision, else the effort the session was launched on.
 */
export function currentLaunchEffort(config: SessionConfig, state: SessionState): string | undefined {
  if (state.observedReasoningEffort !== undefined && observedSinceDecision(config, state))
    return state.observedReasoningEffort;
  return config.launchReasoningEffort;
}
