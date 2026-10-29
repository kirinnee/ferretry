/**
 * WHOSE TURN IT IS, decided from the harness's own evidence.
 *
 * `status` cannot answer it: `running` is written when a session launches and again when a message is
 * sent, and nothing moved it when a turn ended — so every surface that read `running` as "working"
 * spun forever, and a notification keyed on it could not tell the person it was their turn.
 *
 * Two witnesses, read together, and neither alone is trusted for everything:
 *
 *   * THE PANE is the present tense. Both harnesses paint a status line while a turn runs (Claude's
 *     spinner and `esc to interrupt`, Codex's `Working (…)`), show an idle prompt when they are done,
 *     and draw a numbered choice list when a tool needs permission. A live frame saying any of these
 *     is the strongest evidence there is — except a spinner-shaped line with no status line beside it,
 *     which an idle screen can draw too, and which a transcript that ended the turn overrules.
 *   * THE TRANSCRIPT is the record. Codex writes `task_started` / `task_complete` / `turn_aborted`;
 *     Claude writes `end_turn` on the message that finishes a turn. It survives a daemon restart and
 *     answers when the pane cannot be read — but Claude writes nothing when a turn is interrupted, so
 *     the transcript alone can say "working" about an agent that stopped.
 *
 * A turn is ENDED (`your-turn`) on weak evidence only after it is seen twice running — see
 * {@link settleTurnState}. One frame caught between two redraws must never fire a "your turn"
 * notification while the agent is still working.
 *
 * PURE AND TOTAL: values in, values out. Nothing here reads a file or a terminal.
 */

import type {
  HarnessDialog,
  PermissionRequest,
  SessionState,
  SessionStatus,
  SessionTurnState,
} from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';

/** What one live frame of the agent's pane shows. */
export interface TurnPaneEvidence {
  /** The harness's own working line: spinner, elapsed clock, token counter or interrupt hint. */
  readonly working: boolean;
  /**
   * `working` rests on a spinner-shaped line alone — no interrupt hint, elapsed clock or token counter
   * anywhere on screen. A running turn draws that status line too, so this is the one pane reading a
   * transcript that says the turn ENDED may overrule.
   */
  readonly spinnerOnly?: boolean | undefined;
  /** An idle prompt the harness would accept a message at. */
  readonly atPrompt: boolean;
  /** A permission (or other choice) prompt nothing moves past until a person answers. */
  readonly permission: boolean;
  /**
   * A harness dialog the session is parked on — a one-shot nudge, a trust or theme screen — as the
   * words a person is shown for it. Like a permission prompt, nothing moves until somebody answers.
   */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt on screen, read as data — what it asks and the choices it offers. */
  readonly request?: PermissionRequest | undefined;
  /** The harness's own dialog on screen — hooks to review, an update, a sign-in — read as data. */
  readonly dialog?: HarnessDialog | undefined;
}

/** What the transcript's tail says about the current turn. */
export type TranscriptTurnPhase = 'working' | 'ended' | 'unknown';

/** The statuses whose turn this module may describe. Every other status already says what it is. */
const TURN_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'thinking',
  'tool_running',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
]);

/** Statuses that are, by their own account, waiting for the person. */
const IDLE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['awaiting_user', 'interrupted']);

/**
 * The phase of the newest turn in a transcript tail.
 *
 * Read from the END: the first turn boundary met decides, and so does the first piece of turn work —
 * a person's message, the agent's reply, its reasoning, a tool call or a tool result — because any of
 * those after the last boundary is a turn that has not ended yet. Bookkeeping records (usage,
 * settings, attachments, errors, system and developer notes) say nothing about whose turn it is.
 */
export function transcriptTurnPhase(events: readonly TranscriptEvent[]): TranscriptTurnPhase {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'turn') return event.state === 'started' ? 'working' : 'ended';
    if (event.kind === 'usage' || event.kind === 'settings' || event.kind === 'attachment' || event.kind === 'error')
      continue;
    if (event.role === 'system' || event.role === 'developer') continue;
    return 'working';
  }
  return 'unknown';
}

/** Everything one decision reads. */
export interface TurnEvidence {
  readonly state: Pick<SessionState, 'status' | 'turn' | 'pendingQuestion'>;
  readonly transcript: TranscriptTurnPhase;
  /** `undefined` when no frame could be read this time. */
  readonly pane: TurnPaneEvidence | undefined;
}

/**
 * One observation's answer, and how strong it is.
 *
 * `confirmed` is false only for a `your-turn` that the evidence does not agree on — the pane alone,
 * or the transcript alone. Everything else (the agent visibly working, a person being asked
 * something, the pane AND the transcript both saying the turn ended) is confirmed on sight.
 */
export interface TurnObservation {
  readonly state: SessionTurnState;
  readonly confirmed: boolean;
  /** The harness dialog behind a `needs-input`, when that is what it is. */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt behind a `needs-input`, when that is what it is. */
  readonly request?: PermissionRequest | undefined;
  /** The harness dialog behind a `needs-input`, read as data, when that is what it is. */
  readonly dialog?: HarnessDialog | undefined;
}

/**
 * The turn this evidence shows, or `undefined` for a session whose turn is not this module's to
 * describe (not live) or about which there is no evidence at all.
 */
export function observeTurn(evidence: TurnEvidence): TurnObservation | undefined {
  const { state, transcript, pane } = evidence;
  if (!TURN_STATUSES.has(state.status)) return undefined;
  if (state.status === 'awaiting_question' || (state.pendingQuestion ?? null) !== null)
    return { state: 'needs-input', confirmed: true };
  if (pane?.dialog !== undefined)
    return {
      state: 'needs-input',
      confirmed: true,
      dialog: pane.dialog,
      ...(pane.prompt === undefined ? {} : { prompt: pane.prompt }),
    };
  if (pane?.prompt !== undefined) return { state: 'needs-input', confirmed: true, prompt: pane.prompt };
  if (pane?.request !== undefined) return { state: 'needs-input', confirmed: true, request: pane.request };
  if (pane?.permission === true) return { state: 'needs-input', confirmed: true };
  // A spinner-shaped line with no live status line beside it is ambiguous, and the transcript's own turn
  // boundary decides it: a finished turn keeps no spinner, so an end the record proves outranks a shape
  // on an idle screen. Weak in both directions, it still needs two looks — see `settleTurnState`.
  if (pane?.working === true && pane.spinnerOnly === true && transcript === 'ended')
    return { state: 'your-turn', confirmed: false };
  if (pane?.working === true) return { state: 'working', confirmed: true };
  if (pane?.atPrompt === true) return { state: 'your-turn', confirmed: transcript !== 'working' };
  if (transcript === 'working') return { state: 'working', confirmed: true };
  if (transcript === 'ended') return { state: 'your-turn', confirmed: false };
  if (IDLE_STATUSES.has(state.status) || state.turn === 0) return { state: 'your-turn', confirmed: true };
  return undefined;
}

/**
 * The turn to RECORD, given what was recorded, this observation and the previous one.
 *
 * A confirmed observation is recorded at once. An unconfirmed `your-turn` is recorded only when the
 * observation before it said the same — two frames, a few seconds apart, both idle — so a single
 * frame between two spinner redraws cannot end a turn. A session whose turn is not this module's to
 * describe has its record cleared, so a finished session never carries a stale `working`.
 */
export function settleTurnState(
  recorded: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
  previous: TurnObservation | undefined,
  live: boolean,
): SessionTurnState | undefined {
  if (!live) return undefined;
  if (observation === undefined) return recorded;
  if (observation.confirmed) return observation.state;
  return previous?.state === observation.state ? observation.state : recorded;
}

/**
 * The dialog to RECORD beside `next`: the one a `needs-input` observation saw (none for a permission
 * prompt), the one already recorded when this observation did not decide the turn, and none for any
 * turn but `needs-input`.
 */
export function settleTurnPrompt(
  recorded: string | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): string | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.prompt : recorded;
}

/** Whether a status is one this module describes; any other has no turn. */
export const isTurnStatus = (status: SessionStatus): boolean => TURN_STATUSES.has(status);

/**
 * The state patch recording `next`, or nothing when it is already recorded.
 *
 * `turnStateAt` moves only when the value CHANGES, which is what lets a reader tell a new turn
 * boundary from the same one read again — and fire one notification per boundary, not per read.
 */
export function turnStatePatch(
  current: Pick<SessionState, 'turnState' | 'turnStateAt'>,
  next: SessionTurnState | undefined,
  at: string,
): Partial<Pick<SessionState, 'turnState' | 'turnStateAt'>> | undefined {
  if (current.turnState === next) return undefined;
  return next === undefined ? { turnState: undefined, turnStateAt: undefined } : { turnState: next, turnStateAt: at };
}

/**
 * The permission request to RECORD beside `next`, by the same rule as {@link settleTurnPrompt}: the one
 * a `needs-input` observation read, the one already recorded when this observation did not decide the
 * turn, and none for any turn but `needs-input`.
 */
export function settlePermissionRequest(
  recorded: PermissionRequest | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): PermissionRequest | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.request : recorded;
}

/** The harness dialog to RECORD beside `next`, by the same rule as {@link settlePermissionRequest}. */
export function settleHarnessDialog(
  recorded: HarnessDialog | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): HarnessDialog | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.dialog : recorded;
}
