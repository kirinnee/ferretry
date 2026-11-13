/**
 * The model, reasoning effort and fast mode a session is ON, which is what a relaunch must keep.
 *
 * Two records say it, and neither is enough alone:
 *
 *   * `config.model` is the daemon's DECISION — what the start, the move or the last relaunch
 *     put on the argv. It is the only record of a `[1m]` selector, which a harness strips from what it
 *     reports.
 *   * `state.observedModel` is the harness's own REPORT, folded from its transcript. It is the only
 *     record of a switch the owner made by typing `/model` into the pane, which the daemon never sees.
 *
 * So the observation wins when it is NEWER than the decision and names a different model this
 * account can serve; otherwise the decision stands. "Newer" matters: a move records a new
 * decision while the state still holds the old account's last observation, and that observation must
 * not drag the session back onto the model it just left.
 */

import type { SessionConfig, SessionState } from '../../protocol/session.ts';

/** Who chose a session's launch model: the person, or the account's default. */
export type LaunchModelSource = NonNullable<SessionConfig['launchModelSource']>;

/** What the planner reports as a model's source, narrowed to what a session document records. */
export function plannedModelSource(source: string): LaunchModelSource {
  return source === 'requested' ? 'requested' : 'account-default';
}

/** A `[1m]`-style selector suffix, which a harness drops from the model it reports. */
const SELECTOR = /\[[^\]]*\]$/u;

/** The same model, give or take the selector a harness does not echo. */
const sameModel = (left: string, right: string): boolean => left.replace(SELECTOR, '') === right.replace(SELECTOR, '');

/** When the daemon last decided this session's model: its last move, else its creation. */
const decidedAt = (config: SessionConfig): string => config.move?.at ?? config.createdAt;

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

/**
 * The model a MOVE should ask the target for, or nothing when the target's own default should decide.
 *
 * A move onto the SAME runtime (Restart) keeps the model the session is on. A move onto ANOTHER runtime
 * keeps it only when the person picked it: the harness reported a different model after the decision
 * (`/model`), the start or move named it (`launchModelSource: 'requested'`), or — for a session
 * recorded before the source was stamped — it is not the source account's default. A model that was
 * only the source runtime's default must not follow the session onto a runtime with its own (B191).
 */
export function movedModel(input: {
  readonly config: SessionConfig;
  readonly state: SessionState;
  /** The SOURCE account's current default model, for a session with no recorded source. */
  readonly sourceDefault: string | undefined;
  readonly crossing: { readonly sameRuntime: boolean };
  readonly servable: (model: string) => boolean;
}): string | undefined {
  const { config, state, sourceDefault, crossing, servable } = input;
  const current = currentLaunchModel(config, state, servable);
  if (crossing.sameRuntime || current === undefined) return current;
  const decided = config.model;
  if (decided === undefined) {
    // A start that named no model records none, so the harness's first report is the account's own
    // default being echoed back, not a pick. Only a report of a DIFFERENT model is a `/model` switch.
    // (A default given as an alias, `opus[1m]`, never matches the full id a harness reports, so such a
    // report still reads as a pick; `currentLaunchModel` has the same limit.)
    return sourceDefault !== undefined && sameModel(current, sourceDefault) ? undefined : current;
  }
  if (!sameModel(decided, current)) return current; // observed /model switch
  return modelPicked(config, sourceDefault) ? current : undefined;
}

/** The source recorded on a document, or — for one written before it was stamped — worked out from its model. */
function recordedModelSource(config: SessionConfig, sourceDefault: string | undefined): LaunchModelSource {
  if (config.launchModelSource !== undefined) return config.launchModelSource;
  return config.model !== undefined && (sourceDefault === undefined || !sameModel(config.model, sourceDefault))
    ? 'requested'
    : 'account-default';
}

const modelPicked = (config: SessionConfig, sourceDefault: string | undefined): boolean =>
  recordedModelSource(config, sourceDefault) === 'requested';

/** Who chose a model that nothing else says was picked: it was the account's default exactly when it is. */
export function pickedModelSource(model: string, accountDefault: string | undefined): LaunchModelSource {
  return accountDefault !== undefined && sameModel(model, accountDefault) ? 'account-default' : 'requested';
}

/**
 * The source a Restart or move records beside the model it writes.
 *
 *   * A request that named a model: the person picked it.
 *   * No keep (the target's default decided): the account's default.
 *   * The keep ran and landed on the model the document already recorded: whoever chose it still did,
 *     so the recorded source stays (a legacy document's is worked out from its model).
 *   * The keep ran and landed on another model: it adopted a `/model` switch the daemon never saw, which
 *     the person picked.
 */
export function movedModelSource(input: {
  readonly config: SessionConfig;
  readonly sourceDefault: string | undefined;
  readonly named: boolean;
  readonly kept: boolean;
  /** The model the move records. */
  readonly model: string;
}): LaunchModelSource {
  const { config, sourceDefault, named, kept, model } = input;
  if (named) return 'requested';
  if (!kept) return 'account-default';
  const baseline = config.model ?? sourceDefault;
  return baseline !== undefined && sameModel(model, baseline)
    ? recordedModelSource(config, sourceDefault)
    : 'requested';
}

/**
 * The source a revive records when it rewrites the model, or nothing to leave the recorded one as it is.
 * A revive that adopted a `/model` switch (the model differs from the one on record, or from the account's
 * default when none is) writes that pick down, because it also overwrites the decision the switch was
 * measured against.
 */
export function relaunchModelSource(input: {
  readonly config: SessionConfig;
  readonly accountDefault: string | undefined;
  /** The model the revive records. */
  readonly model: string;
}): LaunchModelSource | undefined {
  const { config, accountDefault, model } = input;
  const baseline = config.model ?? accountDefault;
  if (baseline !== undefined && sameModel(model, baseline)) return undefined;
  return pickedModelSource(model, accountDefault);
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
 * The reasoning effort a relaunch should ask for: the harness's report when it is newer than the
 * last decision, else the effort the session was launched on.
 */
export function currentLaunchEffort(config: SessionConfig, state: SessionState): string | undefined {
  if (state.observedReasoningEffort !== undefined && observedSinceDecision(config, state))
    return state.observedReasoningEffort;
  return config.launchReasoningEffort;
}
