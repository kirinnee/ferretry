import type { Task, TaskAuthorizationProvenance, TaskErrorCode, TaskId } from '@ferretry/protocol';
import should from 'should';
import { TaskError } from '../../../src/lib/tasks/task-error.ts';
import type { TaskActor } from '../../../src/lib/tasks/task-policy.ts';
import type { TaskMutationContext } from '../../../src/lib/tasks/task-reducer.ts';
import type { TaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';

const INSTANT = '2026-07-30T12:00:00Z';
export const LATER_INSTANT = '2026-07-30T12:05:00Z';
export const SESSION_ID = 'session-alpha';

export const task = (overrides: Partial<Task> = {}): Task => ({
  v: 1,
  id: 'F1' as TaskId,
  kind: 'feature',
  title: 'Ship the task store',
  description: 'A durable session board.',
  ask: { text: 'build the store', source: 'human' },
  clarifications: [],
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: INSTANT,
  createdBy: 'wilfredo',
  updatedAt: INSTANT,
  ...overrides,
});

/** A board holding exactly these tasks, each with the minimum history the schema accepts. */
export const snapshotOf = (...tasks: readonly Task[]): TaskSnapshot => ({
  v: 1,
  tasks: tasks.map(record => ({
    task: record,
    activity: [
      {
        v: 1,
        seq: 1,
        time: INSTANT,
        actor: 'wilfredo',
        actorName: 'Wilfredo',
        type: 'created',
        data: {
          status: record.status,
          phase: record.phase,
          workflow: record.workflow,
          kind: record.kind,
          title: record.title,
          askSource: record.ask.source,
          dependsOn: [...record.dependsOn],
          reason: record.statusReason ?? 'Task created.',
        },
      },
    ],
  })),
});

export const agent = (overrides: Partial<TaskActor> = {}): TaskActor => ({
  kind: 'agent',
  id: 'wilfredo',
  name: 'Wilfredo',
  sessionId: SESSION_ID,
  ...overrides,
});

export const human = (): TaskActor => ({ kind: 'human', id: 'operator', name: 'Operator', sessionId: null });

/** The grant a board resolves for a top agent, exactly as the task mount hands it to the reducer. */
export const MARK_DONE_GRANT: TaskAuthorizationProvenance = {
  boardId: 'board-1',
  role: 'top_agent',
  boardEpoch: 4,
  coordinatorEpoch: 2,
  runtimeGeneration: 7,
  action: 'mark_done',
  requestId: 'click-1',
};

/** An actor as the task mount leaves it once a shared-board `mark_done` grant is resolved. */
export const topAgent = (sessionId: string = SESSION_ID): TaskActor => ({
  ...agent({ sessionId }),
  boardAuthorizedForSession: sessionId,
  markDoneAuthorization: MARK_DONE_GRANT,
});

export const context = (actor: TaskActor = agent(), at = LATER_INSTANT): TaskMutationContext => ({
  actor,
  sessionId: SESSION_ID,
  at,
});

/** Asserts the call fails as a domain error carrying the expected protocol code, not just any throw. */
export const shouldRefuse = (code: TaskErrorCode, act: () => unknown): TaskError => {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  should(thrown).be.instanceof(TaskError);
  should((thrown as TaskError).code).equal(code);
  return thrown as TaskError;
};
