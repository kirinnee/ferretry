import type { BoardErrorCode } from '@ferretry/protocol';
import type { BoardStanding } from './authority.ts';

/**
 * A refusal in the board protocol's own taxonomy (`BoardErrorCodeSchema`): something the CALLER asked
 * that the board will not do. The message is what the caller reads, so it always says what to do
 * instead; `allowed` names who may do it when the refusal is about authority.
 */
export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly allowed: readonly BoardStanding[];

  constructor(code: BoardErrorCode, message: string, allowed: readonly BoardStanding[] = []) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
    this.allowed = allowed;
  }
}

/**
 * The whole message a persistence refusal answers with. Fixed, for the reason `LANE_SET_UNAVAILABLE_MESSAGE`
 * gives: the API is reachable by every agent on the host, and a message interpolated from the failure
 * would hand each of them the operator's state-home path. The evidence stays in `detail`.
 */
export const BOARD_UNAVAILABLE_MESSAGE = 'the board cannot be written right now';

/**
 * Board state the daemon holds but refuses to write: a quarantined card (overwriting it would destroy
 * the evidence), or a daemon that has not opened its machine identity yet. Not a {@link BoardError},
 * because the caller did nothing wrong.
 */
export class BoardUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(BOARD_UNAVAILABLE_MESSAGE);
    this.name = 'BoardUnavailableError';
    this.detail = detail;
  }
}
