import type { TaskBoardErrorCode } from '@ferretry/protocol';

export class TaskBoardError extends Error {
  constructor(
    readonly code: TaskBoardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskBoardError';
  }
}

export function isTaskBoardError(error: unknown): error is TaskBoardError {
  return error instanceof TaskBoardError;
}
