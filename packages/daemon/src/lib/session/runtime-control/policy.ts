/**
 * The decidable half of a runtime control: what may be attempted, and against what.
 *
 * Everything here is a pure function of documents already read. Keeping it separate from the service
 * is what lets the preconditions be stated as one ordered list instead of as five `if`s buried
 * between awaits — the order is the contract, and it is checked in a test that reads like the list.
 */

import type { RuntimeControlRequest, SessionView } from '@ferretry/protocol';
import { isPickerQuarantined, pickerInputRefusal } from '../harness/quarantine.ts';
import type { HarnessRuntimeSwitchRequest } from '../harness/runtime-switch.ts';
import { TERMINAL_SEND_STATUSES } from '../send/types.ts';
import { type RuntimePaneObservation, SessionRuntimeError } from './types.ts';

/**
 * Why this session cannot take a control right now, or nothing.
 *
 * TWO OF THE FOUR PRECONDITIONS, and deliberately only two: these are the ones answerable from the
 * session document alone. The pane checks need an observation the caller has to go and take, and
 * taking it before the document has refused would touch tmux for a session that was never eligible.
 */
export function documentRefusal(view: SessionView, clientName: string): SessionRuntimeError | undefined {
  // The SEND domain's set, not a second copy of it. It answers exactly the question asked here — the
  // statuses from which a pane is not a place to type — and a runtime control is a keystroke into the
  // same composer a send uses. Two lists would eventually disagree about `interrupted`.
  if (TERMINAL_SEND_STATUSES.has(view.state.status))
    return new SessionRuntimeError('refused', 'a runtime control requires a running session');
  // That quarantine exists precisely to stop the daemon typing into a modal it could not identify,
  // and a retry of the control that caused it is the most likely thing to do so.
  if (isPickerQuarantined(view.state)) return new SessionRuntimeError('refused', pickerInputRefusal(clientName));
  return undefined;
}

/** Why this pane cannot take a control right now, or nothing. */
export function paneRefusal(pane: RuntimePaneObservation): SessionRuntimeError | undefined {
  // A pane whose harness exited takes keystrokes nowhere.
  if (!pane.alive || pane.dead)
    return new SessionRuntimeError('refused', 'a runtime control requires a live harness pane');
  // The one the browser already promises: a control is refused rather than queued, because `/model`
  // typed behind a running turn either vanishes or arrives as conversation, and a switch that
  // silently applies three minutes later applies to whatever turn is running by then.
  if (!pane.promptReady)
    return new SessionRuntimeError(
      'refused',
      'a runtime control is available only while the harness is waiting at an idle prompt',
    );
  return undefined;
}

/**
 * The switch request this control asks for, in the planner's own vocabulary.
 *
 * `compact` is excluded by the TYPE rather than by a guard, because it is not a switch at all: it
 * takes no model and no effort, and the caller has already returned by the time this is reached.
 */
export function switchRequest(
  view: SessionView,
  request: Exclude<RuntimeControlRequest, { action: 'compact' }>,
): HarnessRuntimeSwitchRequest {
  return {
    harness: view.config.harness,
    ...(request.action === 'model' && request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
  };
}

/**
 * Whether planning this switch needs the live Codex catalog read first.
 *
 * ONLY A TARGETED CODEX SWITCH. A bare picker open needs no catalog, and probing for one would make
 * the manual escape hatch fail exactly when the catalog is what is broken — which is the case the
 * escape hatch exists for.
 */
export function needsLiveCatalog(wanted: HarnessRuntimeSwitchRequest): boolean {
  return wanted.harness === 'codex' && wanted.model !== undefined && wanted.effort !== undefined;
}
