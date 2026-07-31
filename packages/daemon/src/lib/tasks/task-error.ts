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
