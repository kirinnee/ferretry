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

import type { CompactAt } from '../../protocol/compact-at.ts';
import type { SessionConfig, SessionState } from '../../protocol/session.ts';
import { resolveCompactAt } from '../peers/compact-at.ts';

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
  if (decided === undefined || !sameModel(decided, current)) return current; // observed /model switch
  const picked =
    config.launchModelSource !== undefined
      ? config.launchModelSource === 'requested'
      : sourceDefault === undefined || !sameModel(decided, sourceDefault);
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
