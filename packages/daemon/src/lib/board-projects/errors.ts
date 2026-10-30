/** The one code a persistence refusal ever carries. */
const LANE_SET_UNAVAILABLE_CODE = 'unavailable';

/**
 * What a caller is told when the daemon cannot serve its own lane document.
 *
 * FIXED, and the whole `message`, because this error's message is what the HTTP mount puts in a 503
 * body: the API is reachable by every agent on the host, and a message interpolated from the failure
 * would hand each of them the operator's state-home path. The evidence lives in `detail`, which never
 * leaves the daemon.
 */
export const LANE_SET_UNAVAILABLE_MESSAGE = 'the board lanes are damaged and cannot be served';

/**
 * A lane document the daemon holds but refuses to use.
 *
 * The request was well formed and the daemon's own file is the problem, so this is a persistence
 * failure, not a caller mistake: the HTTP mount answers 503, never 400.
 */
export class LaneSetUnavailableError extends Error {
  readonly code = LANE_SET_UNAVAILABLE_CODE;

  /** The evidence: which file, and what the decoder made of it. Diagnostic only — never sent to a client. */
  readonly detail: string;

  constructor(detail: string) {
    super(LANE_SET_UNAVAILABLE_MESSAGE);
    this.name = 'LaneSetUnavailableError';
    this.detail = detail;
  }
}
