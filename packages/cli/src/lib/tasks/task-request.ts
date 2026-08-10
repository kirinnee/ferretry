import {
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  SessionSearchQuerySchema,
  type TaskActionRequest,
  TaskActionRequestSchema,
  type TaskCreateRequest,
  TaskCreateRequestSchema,
  type TaskKind,
  TaskKindSchema,
  TaskLinkFieldSchema,
  TaskPhaseSchema,
  TaskStatusSchema,
  TaskWorkflowSchema,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { refuse } from './errors';
import { requireTaskId } from './task-id';
import { taskTitleIssue } from './task-title';

/** The three board renderings `task list` can produce. */
export const TASK_LIST_VIEWS = ['list', 'kanban', 'dag'] as const;
export type TaskListView = (typeof TASK_LIST_VIEWS)[number];

const describeIssues = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`).join('; ');

/**
 * Parse-don't-validate at the argv boundary: the wire schema is the single definition of a legal
 * request, so cross-field rules (a blocked task needs a reason, a phase must belong to its
 * workflow) are enforced once, here, before a round trip.
 */
function parseOrRefuse<Output>(schema: z.ZodType<Output, unknown>, value: unknown, context: string): Output {
  const result = schema.safeParse(value);
  return result.success ? result.data : refuse(`${context}: ${describeIssues(result.error)}`);
}

function requireChoice<Value extends string>(value: string, allowed: readonly Value[], label: string): Value {
  return (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : refuse(`${label} must be one of ${allowed.join(', ')}, got "${value}"`);
}

/** A whole non-negative count, or a refusal naming the flag that was wrong. */
export function requireCount(value: string, label: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : refuse(`${label} must be a whole number, got "${value}"`);
}

const present = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
};

// ─── create ────────────────────────────────────────────────────────────────────────────────────

export interface TaskCreateOptions {
  readonly kind?: string;
  readonly title?: string;
  readonly ask?: string;
  readonly askSource?: string;
  readonly workflow?: string;
  readonly dependsOn?: readonly string[];
  readonly file?: readonly string[];
  readonly description?: string;
  readonly descriptionFile?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly repo?: string;
  readonly assignee?: string;
  readonly order?: string;
  readonly pr?: readonly string[];
  readonly branch?: string;
  readonly commit?: readonly string[];
  readonly doc?: readonly string[];
}

/**
 * Build the create payload. `description` is passed in already-read so this stays pure: whether it
 * came from `--description` or `--description-file` is the controller's problem, not the schema's.
 */
export function buildTaskCreateRequest(
  options: TaskCreateOptions,
  titleWords: readonly string[],
  description: string,
): TaskCreateRequest {
  const kindFlag = present(options.kind) ?? refuse(`--kind is required (${TaskKindSchema.options.join(', ')})`);
  const kind: TaskKind = requireChoice(kindFlag, TaskKindSchema.options, '--kind');

  // `create --kind feature "Rename the widget"` reads better than repeating --title, so accept both.
  const title = present(options.title) ?? titleWords.join(' ').trim();
  if (title.length === 0) refuse('--title is required (or pass the title as the trailing words)');
  const titleProblem = taskTitleIssue(title);
  if (titleProblem !== null) refuse(titleProblem);

  const askText = present(options.ask);
  const askSource = present(options.askSource);
  if (askText === undefined || askSource === undefined) {
    refuse('create requires --ask with the human words and --ask-source with the link they came from');
  }

  const workflow = requireChoice(present(options.workflow) ?? 'quick', TaskWorkflowSchema.options, '--workflow');
  const statusFlag = present(options.status);
  const status = statusFlag === undefined ? undefined : requireChoice(statusFlag, TaskStatusSchema.options, '--status');

  const files = (options.file ?? []).map(file => file.trim()).filter(file => file.length > 0);
  const dependsOn = (options.dependsOn ?? []).map(value => requireTaskId(value, 'dependency id'));
  const prs = (options.pr ?? []).map(value => value.trim()).filter(value => value.length > 0);
  const commits = (options.commit ?? []).map(value => value.trim()).filter(value => value.length > 0);
  const docs = (options.doc ?? []).map(value => value.trim()).filter(value => value.length > 0);
  const branch = present(options.branch);

  const candidate = {
    kind,
    title,
    description,
    ask: { text: askText, source: askSource },
    workflow,
    dependsOn,
    files,
    ...(status === undefined ? {} : { status }),
    ...(present(options.reason) === undefined ? {} : { statusReason: present(options.reason) }),
    assignee: present(options.assignee) ?? null,
    repo: present(options.repo) ?? null,
    links: {
      ...(prs.length > 0 ? { prs } : {}),
      ...(commits.length > 0 ? { commits } : {}),
      ...(docs.length > 0 ? { docs } : {}),
      ...(branch === undefined ? {} : { branch }),
    },
    order: options.order === undefined ? null : requireCount(options.order, '--order'),
  };
  return parseOrRefuse(TaskCreateRequestSchema, candidate, 'cannot create this task');
}

// ─── list ──────────────────────────────────────────────────────────────────────────────────────

export interface TaskListOptions {
  readonly repo?: string;
  readonly assignee?: string;
  readonly kind?: string;
  readonly status?: readonly string[];
  readonly view?: string;
  /** Free text matched against a task's number, title, description, original ask and clarifications. */
  readonly query?: string;
}

/** The filter pairs `task list` sends as its query string, already validated against the wire enums. */
export function buildTaskListFilters(options: TaskListOptions): readonly (readonly [string, string])[] {
  const filters: (readonly [string, string])[] = [];
  const repo = present(options.repo);
  if (repo !== undefined) filters.push(['repo', repo]);
  const assignee = present(options.assignee);
  if (assignee !== undefined) filters.push(['assignee', assignee]);
  const kind = present(options.kind);
  if (kind !== undefined) filters.push(['kind', requireChoice(kind, TaskKindSchema.options, '--kind')]);
  for (const raw of options.status ?? []) {
    const status = present(raw);
    if (status !== undefined) filters.push(['status', requireChoice(status, TaskStatusSchema.options, '--status')]);
  }
  // Sent as `q` and validated by the daemon, which is where the search decision lives: matching needs
  // the description, original ask and clarifications, and the list route deliberately does not carry
  // them. Refusing an over-long term here as well keeps the failure at the terminal instead of costing
  // a request that can only come back 400.
  if (options.query !== undefined) filters.push(['q', requireSearchQuery(options.query)]);
  return filters;
}

/** A search term the daemon will accept, refused at the terminal when it cannot be. */
function requireSearchQuery(value: string): string {
  const parsed = SessionSearchQuerySchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`--query must be between 1 and ${MAX_SESSION_SEARCH_QUERY_LENGTH} characters of search text`);
  return parsed.data;
}

export function resolveTaskListView(options: TaskListOptions): TaskListView {
  return requireChoice(present(options.view) ?? 'list', TASK_LIST_VIEWS, '--view');
}

// ─── actions ───────────────────────────────────────────────────────────────────────────────────

const action = (candidate: unknown, context: string): TaskActionRequest =>
  parseOrRefuse(TaskActionRequestSchema, candidate, context);

export function buildStatusAction(
  status: string,
  options: { readonly reason?: string; readonly note?: string },
): TaskActionRequest {
  const target = requireChoice(status, TaskStatusSchema.options, 'status');
  const reason = present(options.reason);
  if (reason === undefined) refuse(`status "${target}" requires --reason so the history records why it moved`);
  return action(
    {
      action: 'status',
      status: target,
      reason,
      ...(present(options.note) === undefined ? {} : { note: options.note }),
    },
    'cannot change this status',
  );
}

export function buildPhaseAction(phase: string, options: { readonly reason?: string }): TaskActionRequest {
  const target = requireChoice(phase, TaskPhaseSchema.options, 'phase');
  const reason = present(options.reason);
  if (reason === undefined) refuse(`phase "${target}" requires --reason so the history records why it moved`);
  return action({ action: 'phase', phase: target, reason }, 'cannot change this phase');
}

export function buildReopenAction(options: {
  readonly reason?: string;
  readonly ask?: string;
  readonly source?: string;
}): TaskActionRequest {
  const reason = present(options.reason);
  const ask = present(options.ask);
  const source = present(options.source);
  if (reason === undefined || ask === undefined || source === undefined) {
    refuse('reopen requires --reason, --ask with the verbatim new human ask, and --source with its link');
  }
  return action({ action: 'reopen', reason, ask, source }, 'cannot reopen this task');
}

export function buildClarifyAction(
  textWords: readonly string[],
  options: { readonly source?: string },
): TaskActionRequest {
  const text = textWords.join(' ').trim();
  const source = present(options.source);
  if (text.length === 0 || source === undefined) {
    refuse('clarify requires the verbatim text and --source with the link it came from');
  }
  return action({ action: 'clarify', text, source }, 'cannot record this clarification');
}

export function buildDependencyAction(dependencyId: string, options: { readonly remove?: boolean }): TaskActionRequest {
  return action(
    { action: 'dependency', taskId: requireTaskId(dependencyId, 'dependency id'), remove: options.remove === true },
    'cannot change this dependency',
  );
}

export function buildFileAction(
  path: string,
  options: { readonly remove?: boolean; readonly reason?: string },
): TaskActionRequest {
  const claim = path.trim();
  if (claim.length === 0) refuse('file needs a path, for example `task file F21 src/widget.ts`');
  // File claims are advisory, never a lock, so --reason stays optional here unlike status and phase.
  return action(
    {
      action: 'file',
      path: claim,
      remove: options.remove === true,
      ...(present(options.reason) === undefined ? {} : { reason: present(options.reason) }),
    },
    'cannot change this file claim',
  );
}

export function buildTextAction(kind: 'note' | 'feedback', textWords: readonly string[]): TaskActionRequest {
  const text = textWords.join(' ').trim();
  if (text.length === 0) refuse(`${kind} needs some text`);
  return action({ action: kind, text }, `cannot record this ${kind}`);
}

export interface TaskLinkOptions {
  readonly pr?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly doc?: string;
}

export function buildLinkAction(options: TaskLinkOptions): TaskActionRequest {
  const chosen = TaskLinkFieldSchema.options
    .map(field => ({ field, value: present(options[field]) }))
    .filter((entry): entry is { field: (typeof TaskLinkFieldSchema.options)[number]; value: string } => {
      return entry.value !== undefined;
    });
  const only = chosen[0];
  if (only === undefined || chosen.length > 1) {
    refuse(`link needs exactly one of ${TaskLinkFieldSchema.options.map(field => `--${field}`).join(', ')}`);
  }
  return action({ action: 'link', field: only.field, value: only.value }, 'cannot record this link');
}

export function buildAssignAction(who: string | undefined, options: { readonly none?: boolean }): TaskActionRequest {
  if (options.none === true) {
    if (present(who) !== undefined) refuse('pass a teammate or --none, not both');
    return action({ action: 'assign', assignee: null }, 'cannot assign this task');
  }
  const assignee = present(who) ?? refuse('assign needs a teammate, or --none to unassign');
  return action({ action: 'assign', assignee }, 'cannot assign this task');
}

export function buildOrderAction(rank: string | undefined, options: { readonly none?: boolean }): TaskActionRequest {
  if (options.none === true) {
    if (present(rank) !== undefined) refuse('pass a rank or --none, not both');
    return action({ action: 'order', order: null }, 'cannot reorder this task');
  }
  const value = present(rank) ?? refuse('order needs a rank, or --none to unrank');
  return action({ action: 'order', order: requireCount(value, 'order') }, 'cannot reorder this task');
}
