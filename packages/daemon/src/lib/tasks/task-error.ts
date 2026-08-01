import type { TaskErrorCode } from '@ferretry/protocol';

/** A domain failure expressed in the task protocol's stable error taxonomy. */
export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/** The one code a persistence refusal ever carries. Not a `TaskErrorCode`, and deliberately the same
 *  string the task-board domain uses for the identical condition. */
const TASK_UNAVAILABLE_CODE = 'unavailable';

/**
 * What a caller is told when the daemon cannot serve its own task state.
 *
 * FIXED, and the whole `message`, because this error's message is what the HTTP mount puts in a 503
 * body: the API is reachable by every agent on the host, and a message interpolated from the failure
 * would hand each of them the operator's state-home path — their user name with it. The evidence
 * lives in `detail`, which never leaves the daemon.
 */
export const TASK_UNAVAILABLE_MESSAGE = 'the task board is damaged and cannot be served';

/**
 * Durable task state the daemon holds but refuses to use.
 *
 * DELIBERATELY NOT a `TaskErrorCode`. That taxonomy describes what a CALLER did — an invalid body, a
 * refused transition, a task that is not there — and a damaged snapshot is none of those: the request
 * was well formed and the daemon's own file is the problem. Reported inside the caller's taxonomy it
 * came out as `invalid`, which the HTTP mount answers 400, sending an operator to audit a request
 * that was never at fault. A separate type keeps the protocol enum unchanged and still lets every
 * boundary tell "you asked wrongly" from "this daemon cannot serve its own state".
 *
 * It names the same condition the task-board repository already raises as `unavailable` over a
 * document it will not read, and carries the same code, so the two persistence refusals read
 * identically on the wire.
 *
 * The message is not the caller's to choose and not the raiser's either: it is
 * {@link TASK_UNAVAILABLE_MESSAGE}, always, so no construction of this error can put a path on the
 * wire. What was actually wrong goes in `detail`, for the operator reading the daemon's own output.
 */
export class TaskStateUnavailableError extends Error {
  readonly code = TASK_UNAVAILABLE_CODE;

  /** The evidence: which file, and what the decoder made of it. Diagnostic only — the HTTP mount
   *  answers with `message`, so this never reaches a client. */
  readonly detail: string;

  constructor(detail: string) {
    super(TASK_UNAVAILABLE_MESSAGE);
    this.name = 'TaskStateUnavailableError';
    this.detail = detail;
  }
}
