import type {
  FleetTaskListResponse,
  ScopedTaskDetailResponse,
  ScopedTaskView,
  SessionTaskListResponse,
  TaskActionRequest,
  TaskCreateRequest,
  TaskId,
} from '@ferretry/protocol';
import type { TaskScope } from './task-scope';

/**
 * Everything the task commands need from the daemon, declared here so the decision layer never sees
 * a URL, a header or a socket. The adapter that implements it speaks `@ferretry/protocol` over HTTP.
 */
export interface ITaskGateway {
  create(sessionId: string, request: TaskCreateRequest): Promise<ScopedTaskView>;
  list(
    scope: TaskScope,
    filters: readonly (readonly [string, string])[],
  ): Promise<SessionTaskListResponse | FleetTaskListResponse>;
  show(sessionId: string, id: TaskId, afterSequence: number): Promise<ScopedTaskDetailResponse>;
  act(sessionId: string, id: TaskId, request: TaskActionRequest): Promise<ScopedTaskView>;
}

/** Reading `--description-file` is IO; the controller asks for the text and stays pure. */
export interface ITextFileReader {
  readText(path: string): Promise<string>;
}

/**
 * The slice of the terminal port the task controllers use. `ConsoleIo` satisfies it structurally, so
 * nothing new is written for the terminal and `src/lib` still owns the interface it depends on.
 */
export interface ITaskOutput {
  success(message: string): void;
}
