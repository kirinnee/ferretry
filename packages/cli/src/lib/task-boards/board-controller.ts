import type { ITaskOutput } from '../tasks/ports';
import type { TaskBoardCommand } from './board-command';
import { type TaskBoardCredentials, taskBoardHeaders } from './board-credentials';
import { renderTaskBoardResponse } from './board-redaction';

/** Everything the board commands need from the daemon, behind one seam. */
export interface ITaskBoardGateway {
  send(command: TaskBoardCommand, headers: Readonly<Record<string, string>>): Promise<unknown>;
}

/**
 * `fy task-board …` — every command is "prove who you are, call one route, print the redacted
 * answer". The variation lives in the parsed command and the credential it requires, so one
 * controller serves the group rather than eleven copies of the same three lines.
 */
export class TaskBoardController {
  constructor(
    private readonly gateway: ITaskBoardGateway,
    private readonly output: ITaskOutput,
    private readonly credentials: TaskBoardCredentials,
  ) {}

  async run(command: TaskBoardCommand): Promise<void> {
    const headers = taskBoardHeaders(command, this.credentials);
    const response = await this.gateway.send(command, headers);
    this.output.success(renderTaskBoardResponse(response));
  }
}
