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
 */
export class TaskStateUnavailableError extends Error {
  readonly code = TASK_UNAVAILABLE_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'TaskStateUnavailableError';
  }
}
