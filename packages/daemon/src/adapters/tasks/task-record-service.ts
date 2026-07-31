import type { TaskActionRequest, TaskCreateRequestInput } from '@ferretry/protocol';
import { TaskError } from '../../lib/tasks/task-error.ts';
import { sortTasks } from '../../lib/tasks/task-order.ts';
import type { TaskActor } from '../../lib/tasks/task-policy.ts';
import { assertActorCanWriteSession } from '../../lib/tasks/task-policy.ts';
import type { TaskMutationContext } from '../../lib/tasks/task-reducer.ts';
import { applyTaskAction, createTask, requireTaskEntry } from '../../lib/tasks/task-reducer.ts';
import type { TaskEntry, TaskParseIssue, TaskSnapshot } from '../../lib/tasks/task-snapshot.ts';
import type { TaskStorePort } from '../../lib/tasks/task-store-port.ts';
import type { InstantSource } from './file-operations.ts';
import { SystemInstantSource } from './file-operations.ts';

/** A board read: the entries in board order plus whatever the decoder had to discard. */
export interface TaskBoardRead {
  readonly entries: readonly TaskEntry[];
  readonly parseErrors: readonly TaskParseIssue[];
}

/** The store surface this service needs beyond the port: the decoder's diagnostics. */
export interface DecodingTaskStore extends TaskStorePort<TaskSnapshot> {
  readDecoded(): Promise<{ readonly snapshot: TaskSnapshot; readonly parseErrors: readonly TaskParseIssue[] }>;
}

/**
 * One session's task board.
 *
 * The session is fixed at construction because the store it was handed is that session's
 * authoritative container — a service that accepted a session per call could be pointed at a board
 * it does not own. Every mutation runs inside a single store transaction, so the reducer sees the
 * whole board, allocates against it, and commits record and history together.
 */
export class TaskRecordService {
  private readonly sessionId: string;
  private readonly store: DecodingTaskStore;
  private readonly instants: InstantSource;

  constructor(sessionId: string, store: DecodingTaskStore, instants: InstantSource = new SystemInstantSource()) {
    if (sessionId.trim().length === 0) throw new TaskError('invalid', 'a task board needs a session id');
    this.sessionId = sessionId;
    this.store = store;
    this.instants = instants;
  }

  /** Every task on the board, in the deterministic board order, with decode diagnostics. */
  async list(): Promise<TaskBoardRead> {
    const read = await this.store.readDecoded();
    const byId = new Map(read.snapshot.tasks.map(entry => [entry.task.id, entry]));
    const entries = sortTasks(read.snapshot.tasks.map(entry => entry.task)).map(task => byId.get(task.id) as TaskEntry);
    return { entries, parseErrors: read.parseErrors };
  }

  /** One task and its whole history, or a `not-found` refusal. */
  async detail(id: string): Promise<TaskEntry> {
    return requireTaskEntry(await this.store.read(), id);
  }

  async create(request: TaskCreateRequestInput, actor: TaskActor): Promise<TaskEntry> {
    return await this.mutate(actor, (snapshot, context) => createTask(snapshot, request, context));
  }

  async act(id: string, action: TaskActionRequest, actor: TaskActor): Promise<TaskEntry> {
    return await this.mutate(actor, (snapshot, context) => applyTaskAction(snapshot, id, action, context));
  }

  private async mutate(
    actor: TaskActor,
    reduce: (snapshot: TaskSnapshot, context: TaskMutationContext) => { snapshot: TaskSnapshot; entry: TaskEntry },
  ): Promise<TaskEntry> {
    // Refused before the transaction so an unauthorised caller never takes the board's write lock.
    assertActorCanWriteSession(actor, this.sessionId);
    const context: TaskMutationContext = { actor, sessionId: this.sessionId, at: this.instants.now() };
    return await this.store.transact(snapshot => {
      const outcome = reduce(snapshot, context);
      return { container: outcome.snapshot, result: outcome.entry };
    });
  }
}
