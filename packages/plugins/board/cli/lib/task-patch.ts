/**
 * `fy task patch` and `fy task show --yaml` (docs/board.md § Patch: a task as one document).
 *
 * A card's words are ONE editable document. `taskPatchDocument` prints it with its revision; `composeTaskPatch` reads
 * a patch against the task as it stands, refusing one written against an older revision (read before write), and
 * composes the ONE `edit` action carrying what differs: the same action, validation and governance as `fy task edit`,
 * never a second write path. Pure.
 */
import {
  TASK_PATCH_KEYS,
  type Task,
  type TaskActionRequestInput,
  type TaskPatch,
  CardPatchSchema,
  taskRevision,
} from '../../contract/index.ts';
import { taskTitleIssue } from './task-title.ts';
import { patchProblems, readPatchText, samePatchValue } from './patch-document.ts';

type TaskWords = Pick<
  Task,
  'title' | 'summary' | 'premise' | 'context' | 'terms' | 'brief' | 'howToTest' | 'visibility' | 'progress' | 'history'
>;

type WordKey = Exclude<keyof TaskPatch, 'revision'>;

const WORD_KEYS = TASK_PATCH_KEYS.filter((key): key is WordKey => key !== 'revision');

/** The task as the document `patch` takes back: its revision, then every field it changes ("" when empty). */
export function taskPatchDocument(task: TaskWords): Record<string, unknown> {
  return {
    revision: taskRevision(task),
    ...Object.fromEntries(
      WORD_KEYS.flatMap(key => {
        const value = task[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

/** A patch's text, parsed: the document, or every problem in it, one line each. */
export function parseTaskPatch(
  text: string,
  source: string,
): { readonly ok: true; readonly patch: TaskPatch } | { readonly ok: false; readonly problems: readonly string[] } {
  const read = readPatchText(text, source);
  if (!read.ok) return { ok: false, problems: [read.problem] };
  if (!('revision' in read.value)) {
    return {
      ok: false,
      problems: [
        'revision: required — read the whole task first (task show <id> --yaml prints it), so no part is left out of date',
      ],
    };
  }
  const parsed = CardPatchSchema.safeParse(read.value);
  if (!parsed.success) return { ok: false, problems: patchProblems(parsed.error, TASK_PATCH_KEYS) };
  if (WORD_KEYS.every(key => parsed.data[key] === undefined)) {
    return { ok: false, problems: [`${source} names no field to change: a patch changes at least one`] };
  }
  const title = parsed.data.title;
  const titleProblem = title === undefined ? null : taskTitleIssue(title);
  if (titleProblem !== null) return { ok: false, problems: [`title: ${titleProblem}`] };
  return { ok: true, patch: parsed.data };
}

/** What a task patch asks: the edit to send, nothing (every value matches), or a refusal (read it again). */
export type TaskPatchPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'edit'; readonly request: TaskActionRequestInput };

/** The ONE edit a patch is against `task`; `stale` when the task has changed since the patch's revision was read. */
export function composeTaskPatch(task: TaskWords, patch: TaskPatch): TaskPatchPlan {
  if (patch.revision !== taskRevision(task)) return { kind: 'stale' };
  const fields: Record<string, unknown> = Object.fromEntries(
    WORD_KEYS.flatMap(key => {
      if (key === 'progress') return [];
      const value = patch[key];
      return value === undefined || samePatchValue(value, task[key]) ? [] : [[key, value]];
    }),
  );
  const progress = changedProgressParts(task, patch.progress);
  if (progress !== undefined) fields.progress = progress;
  if (Object.keys(fields).length === 0) return { kind: 'unchanged' };
  return {
    kind: 'edit',
    request: { action: 'edit', revision: patch.revision, ...fields } as TaskActionRequestInput,
  };
}

/**
 * The progress parts a patch names that differ from the task's (a task with no progress reads each part as ""): the progress
 * MERGES BY KEY, so only those go, and the daemon merges them into the task's progress inside its write.
 */
function changedProgressParts(
  task: TaskWords,
  progress: TaskPatch['progress'],
): NonNullable<TaskPatch['progress']> | undefined {
  if (progress === undefined) return undefined;
  const parts = (['now', 'doneSoFar', 'next'] as const).flatMap(part => {
    const value = progress[part];
    return value === undefined || value === (task.progress?.[part] ?? '') ? [] : [[part, value] as const];
  });
  return parts.length === 0 ? undefined : Object.fromEntries(parts);
}
