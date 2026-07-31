import { TASK_SCHEMA_VERSION, TaskActivitySchema, TaskSchema, type Task, type TaskActivity } from '@ferretry/protocol';
import { TaskError } from './task-error.ts';

/** One task snapshot and the complete activity history that belongs to it. */
export interface TaskEntry {
  readonly task: Task;
  readonly activity: readonly TaskActivity[];
}

/** Pure task content embedded in whichever authoritative board container owns it. */
export interface TaskSnapshot {
  readonly v: typeof TASK_SCHEMA_VERSION;
  readonly tasks: readonly TaskEntry[];
}

export interface TaskParseIssue {
  readonly scope: 'snapshot' | 'task' | 'activity';
  readonly taskId: string | null;
  readonly detail: string;
}

export interface DecodedTaskSnapshot {
  readonly snapshot: TaskSnapshot;
  readonly parseErrors: readonly TaskParseIssue[];
  readonly fatal: boolean;
}

const issue = (scope: TaskParseIssue['scope'], taskId: string | null, detail: string): TaskParseIssue => ({
  scope,
  taskId,
  detail,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hintedTaskId = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value['task'])) return null;
  const id = value['task']['id'];
  return typeof id === 'string' && id.length > 0 && id.length <= 32 ? id : null;
};

export const emptyTaskSnapshot = (): TaskSnapshot => ({ v: TASK_SCHEMA_VERSION, tasks: [] });

const fatalSnapshot = (detail: string): DecodedTaskSnapshot => ({
  snapshot: emptyTaskSnapshot(),
  parseErrors: [issue('snapshot', null, detail)],
  fatal: true,
});

const decodeActivity = (value: unknown, taskId: string, parseErrors: TaskParseIssue[]): readonly TaskActivity[] => {
  if (!Array.isArray(value)) {
    parseErrors.push(issue('activity', taskId, 'activity is not an array'));
    return [];
  }
  const activity: TaskActivity[] = [];
  let expectedSequence = 1;
  for (const candidate of value) {
    const parsed = TaskActivitySchema.safeParse(candidate);
    if (!parsed.success) {
      parseErrors.push(issue('activity', taskId, `activity seq ${expectedSequence} is malformed`));
      continue;
    }
    if (parsed.data.seq !== expectedSequence) {
      parseErrors.push(
        issue(
          'activity',
          taskId,
          `activity seq ${parsed.data.seq} is not the expected gap-free seq ${expectedSequence}`,
        ),
      );
      continue;
    }
    activity.push(parsed.data);
    expectedSequence += 1;
  }
  return activity;
};

/** Defensively decodes pure task content without knowing where its enclosing board is stored. */
export const decodeTaskSnapshot = (value: unknown): DecodedTaskSnapshot => {
  if (!isRecord(value)) return fatalSnapshot('task snapshot is not an object');
  if (value['v'] !== TASK_SCHEMA_VERSION) return fatalSnapshot('task snapshot schema version is unknown');
  if (!Array.isArray(value['tasks'])) return fatalSnapshot('task snapshot has no task list');

  const tasks: TaskEntry[] = [];
  const parseErrors: TaskParseIssue[] = [];
  const seen = new Set<string>();
  for (const candidate of value['tasks']) {
    const parsedTask = isRecord(candidate) ? TaskSchema.safeParse(candidate['task']) : null;
    if (parsedTask === null || !parsedTask.success) {
      parseErrors.push(issue('task', hintedTaskId(candidate), 'malformed task record'));
      continue;
    }
    if (seen.has(parsedTask.data.id)) {
      parseErrors.push(issue('task', parsedTask.data.id, 'duplicate task id in snapshot'));
      continue;
    }
    seen.add(parsedTask.data.id);
    const activity = decodeActivity(
      isRecord(candidate) ? candidate['activity'] : undefined,
      parsedTask.data.id,
      parseErrors,
    );
    tasks.push({ task: parsedTask.data, activity });
  }
  return { snapshot: { v: TASK_SCHEMA_VERSION, tasks }, parseErrors, fatal: false };
};

/** Parses JSON only; board placement, path selection, and missing-file policy remain outside core. */
export const parseTaskSnapshot = (rawText: string): DecodedTaskSnapshot => {
  try {
    return decodeTaskSnapshot(JSON.parse(rawText));
  } catch {
    return fatalSnapshot('task snapshot is not valid JSON');
  }
};

/** Schema-validates and clones an entry before it can reach authoritative persistence. */
export const validateTaskEntry = (entry: TaskEntry): TaskEntry => {
  const parsedTask = TaskSchema.safeParse(entry.task);
  if (!parsedTask.success) throw new TaskError('invalid', 'refusing to persist an invalid task');

  const activity: TaskActivity[] = [];
  for (const [index, candidate] of entry.activity.entries()) {
    const parsedActivity = TaskActivitySchema.safeParse(candidate);
    if (!parsedActivity.success) {
      throw new TaskError('invalid', `refusing to persist invalid activity for ${parsedTask.data.id}`);
    }
    const expectedSequence = index + 1;
    if (parsedActivity.data.seq !== expectedSequence) {
      throw new TaskError(
        'invalid',
        `activity seq ${parsedActivity.data.seq} is not the expected gap-free seq ${expectedSequence} for ${parsedTask.data.id}`,
      );
    }
    activity.push(parsedActivity.data);
  }
  return { task: parsedTask.data, activity };
};

/** Validates duplicate IDs and every nested protocol object, returning fresh readonly-compatible values. */
export const validateTaskSnapshot = (snapshot: TaskSnapshot): TaskSnapshot => {
  if (snapshot.v !== TASK_SCHEMA_VERSION) throw new TaskError('invalid', 'task snapshot schema version is unknown');
  const seen = new Set<string>();
  const tasks = snapshot.tasks.map(entry => {
    const validated = validateTaskEntry(entry);
    if (seen.has(validated.task.id)) {
      throw new TaskError('ambiguous', `task ${validated.task.id} exists more than once`);
    }
    seen.add(validated.task.id);
    return validated;
  });
  return { v: TASK_SCHEMA_VERSION, tasks };
};

export const serializeTaskSnapshot = (snapshot: TaskSnapshot): string =>
  `${JSON.stringify(validateTaskSnapshot(snapshot), null, 2)}\n`;
