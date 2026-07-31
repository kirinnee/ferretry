import {
  FleetTaskListResponseSchema,
  type IFyApiClient,
  ScopedTaskDetailResponseSchema,
  type ScopedTaskView,
  ScopedTaskViewSchema,
  SessionTaskListResponseSchema,
  type TaskActionRequest,
  TaskActionRequestSchema,
  type TaskCreateRequest,
  TaskCreateRequestSchema,
  type TaskId,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { ITaskGateway } from '../../lib/tasks/ports';
import type { TaskScope } from '../../lib/tasks/task-scope';

const jsonPost = <Input>(schema: z.ZodType<unknown, Input>, value: Input): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(schema.parse(value)),
  headers: { 'content-type': 'application/json' },
});

const query = (filters: readonly (readonly [string, string])[]): string => {
  if (filters.length === 0) return '';
  const parameters = new URLSearchParams();
  for (const [name, value] of filters) parameters.append(name, value);
  return `?${parameters.toString()}`;
};

/**
 * The task surface of the daemon's HTTP API. This is the only place in the CLI that knows a task
 * lives behind a URL: everything above it depends on {@link ITaskGateway}.
 */
export class FyTaskGateway implements ITaskGateway {
  /**
   * The client is resolved per call rather than at wiring time, so `fy --help` and every command that
   * never reaches the daemon keep working on a host where `FY_URL` is not set.
   */
  constructor(private readonly connect: () => Promise<IFyApiClient>) {}

  private sessionBase(sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`;
  }

  async create(sessionId: string, request: TaskCreateRequest): Promise<ScopedTaskView> {
    const client = await this.connect();
    return client.request(
      this.sessionBase(sessionId),
      ScopedTaskViewSchema,
      jsonPost(TaskCreateRequestSchema, request),
    );
  }

  async list(scope: TaskScope, filters: readonly (readonly [string, string])[]) {
    const client = await this.connect();
    return scope.sessionId === null
      ? client.request(`/v1/tasks${query(filters)}`, FleetTaskListResponseSchema)
      : client.request(`${this.sessionBase(scope.sessionId)}${query(filters)}`, SessionTaskListResponseSchema);
  }

  async show(sessionId: string, id: TaskId, afterSequence: number) {
    const client = await this.connect();
    const suffix = afterSequence > 0 ? `?after=${afterSequence}` : '';
    return client.request(`${this.sessionBase(sessionId)}/${id}${suffix}`, ScopedTaskDetailResponseSchema);
  }

  async act(sessionId: string, id: TaskId, request: TaskActionRequest): Promise<ScopedTaskView> {
    const client = await this.connect();
    return client.request(
      `${this.sessionBase(sessionId)}/${id}`,
      ScopedTaskViewSchema,
      jsonPost(TaskActionRequestSchema, request),
    );
  }
}
