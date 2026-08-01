import type { TaskActionRequest, TaskCreateRequestInput } from '@ferretry/protocol';
import { TaskError } from '../../lib/tasks/task-error.ts';
import { sortTasks } from '../../lib/tasks/task-order.ts';
import type { TaskActor } from '../../lib/tasks/task-policy.ts';
import { assertActorCanWriteSession } from '../../lib/tasks/task-policy.ts';
import type { TaskMutationContext } from '../../lib/tasks/task-reducer.ts';
import { applyTaskAction, createTask, requireTaskEntry } from '../../lib/tasks/task-reducer.ts';
import type { TaskEntry, TaskSnapshot } from '../../lib/tasks/task-snapshot.ts';
import type { TaskStorePort } from '../../lib/tasks/task-store-port.ts';
import type { InstantSource } from './file-operations.ts';
import { SystemInstantSource } from './file-operations.ts';

/** A board read: the entries in board order. Whole, or it is not a read at all — see {@link
 *  TaskRecordService.list}. */
export interface TaskBoardRead {
  readonly entries: readonly TaskEntry[];
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
  private readonly store: TaskStorePort<TaskSnapshot>;
  private readonly instants: InstantSource;

  constructor(
    sessionId: string,
    store: TaskStorePort<TaskSnapshot>,
    instants: InstantSource = new SystemInstantSource(),
  ) {
    if (sessionId.trim().length === 0) throw new TaskError('invalid', 'a task board needs a session id');
    this.sessionId = sessionId;
    this.store = store;
    this.instants = instants;
  }

  /**
   * Every task on the board, in the deterministic board order.
   *
   * AUTHORITATIVE, so it demands a whole snapshot: `read` refuses a damaged one instead of handing
   * back the subset the decoder managed. This used to serve the partial board with a count of what
   * it had dropped, and that is the one shape of answer a board must never give — a list three tasks
   * short is indistinguishable from a board that has three tasks, and it is read by a human deciding
   * what is left to do and by an agent deciding what to pick up. Detail, create and act already
   * refused a damaged board; the list was the hole in that contract.
   *
   * The decoder's partial view is not lost, it is just not an ANSWER: the store's `readDecoded` still
   * carries the valid subset and every parse issue, for an operator diagnosing the file.
   */
  async list(): Promise<TaskBoardRead> {
    const snapshot = await this.store.read();
    const byId = new Map(snapshot.tasks.map(entry => [entry.task.id, entry]));
    const entries = sortTasks(snapshot.tasks.map(entry => entry.task)).map(task => byId.get(task.id) as TaskEntry);
    return { entries };
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
