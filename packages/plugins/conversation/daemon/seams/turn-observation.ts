import type { HarnessDialog, PermissionRequest, SessionState, SessionTurnState } from './protocol.ts';
import type { TranscriptEvent } from './transcript-types.ts';
import {
  isTurnStatus,
  observeTurn,
  settleHarnessDialog,
  settlePermissionRequest,
  settleTurnPrompt,
  settleTurnState,
  type TurnObservation,
  type TurnPaneEvidence,
  transcriptTurnPhase,
} from '../turns/lib/policy.ts';
import { transcriptUsageLimit, type UsageLimit } from '../turns/lib/usage-limit.ts';

/** The durable fields a turn decision reads — what the main thread tells an observer about a session. */
export type TurnFacts = Pick<
  SessionState,
  'status' | 'turn' | 'pendingQuestion' | 'turnState' | 'turnPrompt' | 'permissionRequest' | 'harnessDialog'
>;

/** A recorded change, as the journal and the event stream carry it. */
export interface TurnStateChange {
  readonly from: SessionTurnState | undefined;
  readonly to: SessionTurnState | undefined;
  /** The harness dialog behind `to`, recorded as `turnPrompt`; absent clears it. */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt behind `to`, recorded as `permissionRequest`; absent clears it. */
  readonly request?: PermissionRequest | undefined;
  /** The harness's own dialog behind `to`, recorded as `harnessDialog`; absent clears it. */
  readonly dialog?: HarnessDialog | undefined;
  /**
   * The usage limit the transcript says the newest turn ended on (Codex writes it on the turn boundary and
   * shows no dialog), so the change records the session `rate_limited`; absent proves no limit.
   */
  readonly limit?: UsageLimit | undefined;
}

/** What one look at a LIVE session found: its transcript tail and one frame of its pane. */
export interface TurnLook {
  /** The transcript tail, or `undefined` when no transcript is proved to be this session's yet. */
  readonly transcript: readonly TranscriptEvent[] | undefined;
  /** One live frame of the agent's pane, or `undefined` when there is no pane to read. */
  readonly pane: TurnPaneEvidence | undefined;
}

/** The turn part's answer: the observation to remember for the next look, and the change to record. */
export interface TurnStep {
  readonly observation: TurnObservation | undefined;
  readonly change: TurnStateChange | undefined;
}

/**
 * One turn decision for one session, from its facts, the observation before this one and what this look
 * found — the body of what the turn watcher did per session per tick, with every changing value passed in.
 *
 * `look` is read only for a live session (see {@link isTurnStatus}); a session that is not live has its
 * record cleared and needs nothing looked at. A live session with no look decides nothing this time.
 *
 * A request or a dialog is compared by its id, a digest of everything a person decides on: somebody at
 * the terminal moving the cursor between rows is not a new one and records nothing.
 */
export function stepTurn(
  facts: TurnFacts,
  previous: TurnObservation | undefined,
  look: TurnLook | undefined,
): TurnStep {
  const live = isTurnStatus(facts.status);
  const observation =
    live && look !== undefined
      ? observeTurn({
          state: facts,
          transcript: look.transcript === undefined ? 'unknown' : transcriptTurnPhase(look.transcript),
          pane: look.pane,
        })
      : undefined;
  const next = settleTurnState(facts.turnState, observation, previous, live);
  const prompt = settleTurnPrompt(facts.turnPrompt, next, observation);
  const request = settlePermissionRequest(facts.permissionRequest, next, observation);
  const dialog = settleHarnessDialog(facts.harnessDialog, next, observation);
  const limit = live && look?.transcript !== undefined ? transcriptUsageLimit(look.transcript) : undefined;
  if (
    next === facts.turnState &&
    prompt === facts.turnPrompt &&
    request?.id === facts.permissionRequest?.id &&
    dialog?.id === facts.harnessDialog?.id
  )
    return { observation, change: undefined };
  return {
    observation,
    change: {
      from: facts.turnState,
      to: next,
      ...(prompt === undefined ? {} : { prompt }),
      ...(request === undefined ? {} : { request }),
      ...(dialog === undefined ? {} : { dialog }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}
