/**
 * The model and reasoning effort a session is ON, which is what a relaunch must keep.
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

import type { SessionConfig, SessionState } from '@ferretry/protocol';

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

/**
 * The reasoning effort a relaunch should ask for: the harness's report when it is newer than the
 * last decision, else the effort the session was launched on.
 */
export function currentLaunchEffort(config: SessionConfig, state: SessionState): string | undefined {
  if (state.observedReasoningEffort !== undefined && observedSinceDecision(config, state))
    return state.observedReasoningEffort;
  return config.launchReasoningEffort;
}
