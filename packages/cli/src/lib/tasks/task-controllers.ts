import type { TaskActionRequest } from '@ferretry/protocol';
import { refuse } from './errors';
import type { ITaskOutput, ITaskGateway, ITextFileReader } from './ports';
import { taskReference, requireTaskId } from './task-id';
import { renderTaskBoardMarkdown, renderTaskDetailMarkdown } from './task-markdown';
import { renderTaskAction, renderTaskBoard, renderTaskDag, renderTaskDetail, renderTaskKanban } from './task-render';
import { buildTaskCreateRequest, buildTaskListFilters, requireCount, resolveTaskListView } from './task-request';
import type { TaskCreateOptions, TaskListOptions } from './task-request';
import { requireSessionId, type TaskScope } from './task-scope';

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

export interface TaskCreateInput {
  readonly scope: TaskScope;
  readonly options: TaskCreateOptions;
  readonly titleWords: readonly string[];
  readonly json: boolean;
}

/** `fy task create` — assemble the record, then print its id on its own line so `id=$(…)` works. */
export class TaskCreateController {
  constructor(
    private readonly gateway: ITaskGateway,
    private readonly output: ITaskOutput,
    private readonly files: ITextFileReader,
  ) {}

  async run(input: TaskCreateInput): Promise<void> {
    const sessionId = requireSessionId(input.scope);
    const description = await this.resolveDescription(input.options);
    const request = buildTaskCreateRequest(input.options, input.titleWords, description);
    const task = await this.gateway.create(sessionId, request);
    this.output.success(input.json ? asJson(task) : taskReference(task.id));
  }

  /** The brief is either inline or in a file — never both, because the loser would vanish silently. */
  private async resolveDescription(options: TaskCreateOptions): Promise<string> {
    const path = options.descriptionFile?.trim();
    const inline = options.description;
    if (path === undefined || path.length === 0) return inline ?? '';
    if (inline !== undefined && inline.length > 0) refuse('pass --description or --description-file, not both');
    return this.files.readText(path);
  }
}

export interface TaskListInput {
  readonly scope: TaskScope;
  readonly options: TaskListOptions;
  readonly markdown: boolean;
  readonly json: boolean;
}

/** `fy task list` — one board, three renderings, plus the machine-readable payload. */
export class TaskListController {
  constructor(
    private readonly gateway: ITaskGateway,
    private readonly output: ITaskOutput,
  ) {}

  async run(input: TaskListInput): Promise<void> {
    const view = resolveTaskListView(input.options);
    const filters = buildTaskListFilters(input.options);
    if (input.scope.sessionId === null && filters.some(([name]) => name === 'q')) {
      refuse('--query searches the current session and cannot be combined with --all');
    }
    const board = await this.gateway.list(input.scope, filters);
    if (input.json) return this.output.success(asJson(board));
    if (input.markdown) return this.output.success(renderTaskBoardMarkdown(board));
    const rendered =
      view === 'kanban' ? renderTaskKanban(board) : view === 'dag' ? renderTaskDag(board) : renderTaskBoard(board);
    this.output.success(rendered);
  }
}

export interface TaskShowInput {
  readonly scope: TaskScope;
  readonly id: string;
  readonly after?: string | undefined;
  readonly markdown: boolean;
  readonly json: boolean;
}

/** `fy task show` — the record, its derived annotations, and its history. */
export class TaskShowController {
  constructor(
    private readonly gateway: ITaskGateway,
    private readonly output: ITaskOutput,
  ) {}

  async run(input: TaskShowInput): Promise<void> {
    const sessionId = requireSessionId(input.scope);
    const afterSequence = input.after === undefined ? 0 : requireCount(input.after, '--after');
    const detail = await this.gateway.show(sessionId, requireTaskId(input.id), afterSequence);
    if (input.json) return this.output.success(asJson(detail));
    this.output.success(input.markdown ? renderTaskDetailMarkdown(detail) : renderTaskDetail(detail));
  }
}

export interface TaskActionInput {
  readonly scope: TaskScope;
  readonly id: string;
  readonly request: TaskActionRequest;
  readonly json: boolean;
}

/**
 * Every mutation other than create — status, phase, reopen, clarify, depend, file, note, feedback,
 * link, assign, order. They differ only in the payload the wire union already discriminates, so one
 * controller serves them all rather than eleven copies of the same three lines.
 */
export class TaskActionController {
  constructor(
    private readonly gateway: ITaskGateway,
    private readonly output: ITaskOutput,
  ) {}

  async run(input: TaskActionInput): Promise<void> {
    const sessionId = requireSessionId(input.scope);
    const task = await this.gateway.act(sessionId, requireTaskId(input.id), input.request);
    this.output.success(input.json ? asJson(task) : renderTaskAction(task));
  }
}
