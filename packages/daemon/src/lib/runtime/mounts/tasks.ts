import {
  TASK_SCHEMA_VERSION,
  TaskActionRequestSchema,
  TaskCreateRequestSchema,
  type FleetTaskListResponse,
  type ScopedTaskDetailResponse,
  type ScopedTaskSummary,
  type ScopedTaskView,
  type SessionStatus,
  type SessionTaskListResponse,
  type Task,
  type TaskActionRequest,
  type TaskActivity,
  type TaskCreateRequestInput,
  type TaskErrorCode,
  type TaskLive,
} from '@ferretry/protocol';
import { parseActor, type ApiActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  TaskError,
  TaskStateUnavailableError,
  taskBlockedBy,
  type TaskActor,
  type TaskEntry,
  type TaskParseIssue,
} from '../../tasks/index.ts';

/**
 * The task record board's HTTP surface: one session's tasks, the fleet's tasks, and one task's whole
 * history.
 *
 * This is the route table the CLI's `FyTaskGateway` already speaks — `/v1/sessions/:sessionId/tasks`
 * and `/v1/tasks` — so mounting it is what turns the shipped `fy task` command group from 404s into
 * a working capability. The reducer, the file store and the record service behind it were built and
 * fully tested and nothing constructed them; the daemon had no task boards at all.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. `TaskLive` carries an assignee's health and a staleness
 * verdict. Both are the SUPERVISION subsystem's judgements, and the daemon does not mount one yet:
 * `assigneeHealth` and `staleness` are reported as `null` and `assigneeDoneMarker` as `false`
 * because the daemon genuinely holds no evidence for them, not as a placeholder. What it does hold —
 * which session an assignee names, that session's status, its display name and when it last did
 * anything — comes from the session index and is reported truthfully. Inventing a health verdict
 * from a status enum would put a number on the board that nothing measured.
 */

/**
 * One session's task board, as the routes need it.
 *
 * Declared here rather than imported because the record service is an ADAPTER and `src/lib` may not
 * import `src/adapters`. `TaskRecordService` satisfies this structurally, so the composition root
 * hands one over with no wrapper.
 */
export interface TaskBoardPort {
  list(): Promise<{ readonly entries: readonly TaskEntry[]; readonly parseErrors: readonly TaskParseIssue[] }>;
  detail(id: string): Promise<TaskEntry>;
  create(request: TaskCreateRequestInput, actor: TaskActor): Promise<TaskEntry>;
  act(id: string, action: TaskActionRequest, actor: TaskActor): Promise<TaskEntry>;
}

/** What the daemon's own session index knows about a session right now. Facts, not judgements. */
export interface AssigneeObservation {
  readonly sessionId: string;
  /** The session's display name, or `null` when its configuration document does not carry one. */
  readonly name: string | null;
  readonly status: SessionStatus;
  readonly lastActivityAt: string | null;
}

/**
 * The mounted task subsystem: a board per session, the fleet's session list for the cross-session
 * read, the instant a response is stamped with, and the session lookup the live view is built from.
 */
export interface TaskSubsystem {
  /** The authoritative board for one session. Never derives a path itself — the root decides. */
  board(sessionId: string): TaskBoardPort;
  /** Every session the daemon knows of, for the fleet-wide read. */
  sessionIds(): Promise<readonly string[]>;
  /**
   * The sessions a set of assignees name, keyed by the assignee string that named each one. An
   * assignee absent from the answer names nothing the daemon has ever seen.
   *
   * A BATCH, not one call per row, because an assignee is a teammate CALLSIGN far more often than a
   * session id — `fy task create --assignee <who>` documents it as "the teammate who owns it" — and
   * resolving a callsign means reading the session documents that carry callsigns. Asked per row, a
   * board of two hundred tasks would fan out over the whole fleet two hundred times; asked once for
   * the distinct assignees a response is about, it fans out once however many rows there are.
   */
  observe(assignees: readonly string[]): Promise<ReadonlyMap<string, AssigneeObservation>>;
  /** The instant a list response is stamped with, so an empty board still reports a real time. */
  now(): string;
}

/**
 * How each domain refusal is reported.
 *
 * `read-only` and the transition family are CONFLICTS rather than bad requests — the request was
 * well-formed and the board's current state is what refused it — so they answer 409 and a client can
 * distinguish "you asked wrongly" from "you asked at the wrong time". `ambiguous` is 409 for the same
 * reason: the board holds two records under one id, which is the board's problem to resolve.
 *
 * Every code here describes something a CALLER did, so `invalid` stays 400. A board the store cannot
 * read is not in this table at all — see {@link TASK_UNAVAILABLE_STATUS}.
 */
const TASK_ERROR_STATUS: Readonly<Record<TaskErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'reason-required': 400,
  'not-found': 404,
  forbidden: 403,
  ambiguous: 409,
  transition: 409,
  'approval-required': 409,
  cycle: 409,
  'dependency-conflict': 409,
  'read-only': 409,
};

/**
 * Who the board thinks is acting, derived from the actor the authorization boundary resolved.
 *
 * An in-pane peer is an agent, and the session id comes from the SERVER-derived actor — never from
 * the body — so an agent cannot write another session's board by naming a different one. Everything
 * else reaching an admin-scoped route is the human. A display name is not carried by the API actor,
 * so it is honestly `null` rather than guessed from a client-controlled header.
 */
export function taskActor(actor: ApiActor | undefined): TaskActor {
  const { kind, id, raw } = parseActor(actor ?? '');
  // An empty id is not an agent: `peer:` names no session, and treating it as one would record
  // provenance nothing can be traced back to.
  return kind === 'peer' && id !== undefined && id !== ''
    ? { kind: 'agent', id: raw, name: null, sessionId: id }
    : { kind: 'human', id: raw, name: null, sessionId: null };
}

/**
 * How a persistence refusal is reported: 503, never a 4xx.
 *
 * A damaged board is state this daemon holds and will not serve, not a request anyone should
 * rephrase — the caller could retry the identical request forever and it would keep failing until an
 * operator repairs the file. 503 rather than 500 because 500 in this API means a DEFECT, whose
 * message the dispatcher replaces with a fixed one; this is a known, named condition the daemon can
 * explain. It is the status the task-board mount already gives `unavailable`, raised by the sibling
 * repository over exactly this — a durable document it refuses to read.
 */
const TASK_UNAVAILABLE_STATUS = 503;

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug still
 *  becomes a 500 instead of being reported as the client's fault. */
function reraise(error: unknown): never {
  if (error instanceof TaskStateUnavailableError)
    throw new ApiError(TASK_UNAVAILABLE_STATUS, error.message, error.code);
  if (error instanceof TaskError) throw new ApiError(TASK_ERROR_STATUS[error.code], error.message, error.code);
  throw error;
}

/** A decoded path parameter. `decodeParameter` refuses a traversal or a separator, so a crafted
 *  value can never address a board outside the session tree. */
function pathParameter(context: RouteContext, name: string, code: string): string {
  const decoded = decodeParameter(context.params.get(name) ?? '');
  if (decoded === undefined || decoded === '') throw new ApiError(400, `the ${name} in the path is not usable`, code);
  return decoded;
}

const pathSessionId = (context: RouteContext): string => pathParameter(context, 'sessionId', 'invalid_session_id');
const pathTaskId = (context: RouteContext): string => pathParameter(context, 'taskId', 'invalid_task_id');

/**
 * The board for one session.
 *
 * Acquisition is guarded because the composition root refuses a session id the state-home layout
 * would not accept — a path-unsafe id must never become a directory — and that refusal arrives as a
 * synchronous throw. Left unguarded it would escape as a 500 and blame the daemon for what is
 * squarely a bad request.
 */
function boardFor(subsystem: TaskSubsystem, sessionId: string): TaskBoardPort {
  try {
    return subsystem.board(sessionId);
  } catch (error) {
    reraise(error);
  }
}

/** The activity sequence a detail read should start after. A non-numeric `?after` is the client's
 *  mistake, not a reason to silently return the whole history it already has. */
function afterSequence(request: ApiRequest): number {
  const raw = request.query.get('after')?.[0];
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new ApiError(400, 'after must be a non-negative whole number', 'invalid_after');
  return parsed;
}

/** The list filters the CLI already sends. A filter this daemon does not know about is REFUSED
 *  rather than ignored: answering a narrowed request with the whole board looks like a board that
 *  matched everything, which is a wrong answer rather than a missing feature. */
const TASK_FILTERS = ['repo', 'assignee', 'kind', 'status'] as const;
type TaskFilter = (typeof TASK_FILTERS)[number];

function taskFilters(request: ApiRequest): ReadonlyMap<TaskFilter, string> {
  const filters = new Map<TaskFilter, string>();
  for (const [name, values] of request.query) {
    if (name === 'after') continue;
    const known = TASK_FILTERS.find(filter => filter === name);
    if (known === undefined) throw new ApiError(400, `unknown task filter ${name}`, 'unknown_filter');
    const value = values[0];
    if (value !== undefined) filters.set(known, value);
  }
  return filters;
}

/** Does one task satisfy every filter given? Every filter is an exact match on a field the task
 *  carries, so no filter can ever match a task the caller could not name. */
function matchesFilters(task: Task, filters: ReadonlyMap<TaskFilter, string>): boolean {
  const fields: Readonly<Record<TaskFilter, string | null>> = {
    repo: task.repo,
    assignee: task.assignee,
    kind: task.kind,
    status: task.status,
  };
  for (const [filter, value] of filters) if (fields[filter] !== value) return false;
  return true;
}

/**
 * The live view of a task's assignee.
 *
 * `undefined` means the assignee names nothing the daemon has ever seen, which is reported as an
 * empty observation rather than as an error: a task may legitimately name a teammate that has not
 * been launched. See the header for why health, staleness and the done marker are constant.
 */
export function taskLive(observation: AssigneeObservation | undefined): TaskLive {
  return {
    assigneeSessionId: observation?.sessionId ?? null,
    assigneeName: observation?.name ?? null,
    assigneeStatus: observation?.status ?? null,
    assigneeLastActivityAt: observation?.lastActivityAt ?? null,
    assigneeHealth: null,
    assigneeDoneMarker: false,
    staleness: null,
  };
}

/** The blocking facts, computed over the whole board because a dependency lives in another record. */
function blockage(
  task: Task,
  board: readonly Task[],
): {
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  readonly blockedSince: string | null;
  readonly blockedBy: string[];
} {
  const blockedBy = taskBlockedBy(board, task);
  const declared = task.status === 'blocked';
  return {
    blocked: declared || blockedBy.length > 0,
    // A declared block carries the human's reason; an inferred one is explained by `blockedBy`.
    blockedReason: declared ? task.statusReason : null,
    // The record's last write is the closest thing to "since" the board actually stores; claiming a
    // more precise instant would mean inventing one.
    blockedSince: declared || blockedBy.length > 0 ? task.updatedAt : null,
    blockedBy: [...blockedBy],
  };
}

/**
 * The sessions every assignee on these tasks names, resolved in one pass.
 *
 * DISTINCT, because a board where ten tasks share one owner is one question, not ten. Empty when
 * nothing is assigned, which skips the fan-out entirely rather than asking the fleet about nobody.
 */
async function observeAssignees(
  subsystem: TaskSubsystem,
  tasks: readonly Pick<Task, 'assignee'>[],
): Promise<ReadonlyMap<string, AssigneeObservation>> {
  const assignees = [
    ...new Set(tasks.map(task => task.assignee).filter((assignee): assignee is string => assignee !== null)),
  ];
  return assignees.length === 0 ? new Map() : await subsystem.observe(assignees);
}

/** The live view for one task, from an already-resolved batch. */
function liveFor(task: Pick<Task, 'assignee'>, observations: ReadonlyMap<string, AssigneeObservation>): TaskLive {
  return taskLive(task.assignee === null ? undefined : observations.get(task.assignee));
}

/** One task as the wire sees it, scoped to the session whose board holds it. */
function scopedView(
  sessionId: string,
  task: Task,
  board: readonly Task[],
  observations: ReadonlyMap<string, AssigneeObservation>,
): ScopedTaskView {
  return {
    ...task,
    ...blockage(task, board),
    live: liveFor(task, observations),
    sessionId,
  };
}

/** One task as a list row: the heavy prose is replaced by its size, so a board of 200 tasks is not a
 *  megabyte of description the caller did not ask for. */
function scopedSummary(
  sessionId: string | null,
  task: Task,
  board: readonly Task[],
  observations: ReadonlyMap<string, AssigneeObservation>,
): ScopedTaskSummary {
  const { description, ask, clarifications, ...rest } = task;
  return {
    ...rest,
    ...blockage(task, board),
    live: liveFor(task, observations),
    descriptionChars: description.length,
    askChars: ask.text.length,
    askSource: ask.source,
    clarificationCount: clarifications.length,
    sessionId,
  };
}

/** The ids of the records the decoder had to discard, so a caller can tell a short board from a
 *  damaged one. Absent rather than empty when nothing was discarded. */
function parseErrorIds(issues: readonly TaskParseIssue[]): string[] | undefined {
  const ids = issues.map(issue => issue.taskId).filter((id): id is string => id !== null);
  return ids.length === 0 ? undefined : ids;
}

/** One session's board, filtered and summarised. */
async function listSession(subsystem: TaskSubsystem, sessionId: string, context: RouteContext): Promise<ApiResponse> {
  const filters = taskFilters(context.request);
  const read = await boardFor(subsystem, sessionId).list().catch(reraise);
  const board = read.entries.map(entry => entry.task);
  const damaged = parseErrorIds(read.parseErrors);
  const shown = board.filter(task => matchesFilters(task, filters));
  // Resolved for the rows the caller will actually see, not for the whole board: a filtered list must
  // not fan out over the fleet on behalf of tasks it is about to discard.
  const observations = await observeAssignees(subsystem, shown);
  const response: SessionTaskListResponse = {
    v: TASK_SCHEMA_VERSION,
    sessionId,
    tasks: shown.map(task => scopedSummary(sessionId, task, board, observations)),
    parseErrors: read.parseErrors.length,
    ...(damaged === undefined ? {} : { parseErrorIds: damaged }),
    updatedAt: subsystem.now(),
  };
  return jsonResponse(response);
}

/**
 * Every session's board in one read.
 *
 * A session whose board cannot be read does NOT fail the fleet answer — one damaged board would
 * otherwise hide every healthy one — it contributes to `parseErrors` instead, which is exactly what
 * that counter is for. Rows keep their own `sessionId`, so the caller can still tell whose task it
 * is even though the response's scope is `null`.
 */
async function listFleet(subsystem: TaskSubsystem, context: RouteContext): Promise<ApiResponse> {
  const filters = taskFilters(context.request);
  // Gathered before any assignee is resolved, so ONE batch answers for the whole fleet: resolving
  // inside the loop would fan out over every session once per session's board.
  const gathered: { readonly sessionId: string; readonly task: Task; readonly board: readonly Task[] }[] = [];
  let parseErrors = 0;
  const damaged: string[] = [];
  for (const sessionId of await subsystem.sessionIds()) {
    // Acquisition is inside the guard for the same reason the read is: an id the index holds but the
    // layout refuses is a damaged session, not grounds for failing every healthy board with it.
    const read = await Promise.resolve()
      .then(async () => await subsystem.board(sessionId).list())
      .catch(() => undefined);
    if (read === undefined) {
      parseErrors += 1;
      damaged.push(sessionId);
      continue;
    }
    const board = read.entries.map(entry => entry.task);
    parseErrors += read.parseErrors.length;
    damaged.push(...(parseErrorIds(read.parseErrors) ?? []));
    for (const task of board.filter(candidate => matchesFilters(candidate, filters))) {
      gathered.push({ sessionId, task, board });
    }
  }
  const observations = await observeAssignees(
    subsystem,
    gathered.map(row => row.task),
  );
  const response: FleetTaskListResponse = {
    v: TASK_SCHEMA_VERSION,
    sessionId: null,
    tasks: gathered.map(row => scopedSummary(row.sessionId, row.task, row.board, observations)),
    parseErrors,
    ...(damaged.length === 0 ? {} : { parseErrorIds: damaged }),
    updatedAt: subsystem.now(),
  };
  return jsonResponse(response);
}

/** One task, its whole record, and the history after the sequence the caller already holds. */
async function detail(subsystem: TaskSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const taskId = pathTaskId(context);
  const after = afterSequence(context.request);
  const board = boardFor(subsystem, sessionId);
  const read = await board.list().catch(reraise);
  const entry = await board.detail(taskId).catch(reraise);
  const activity: readonly TaskActivity[] = entry.activity.filter(event => event.seq > after);
  const response: ScopedTaskDetailResponse = {
    sessionId,
    task: scopedView(
      sessionId,
      entry.task,
      read.entries.map(other => other.task),
      await observeAssignees(subsystem, [entry.task]),
    ),
    activity: [...activity],
  };
  return jsonResponse(response);
}

/**
 * The create body, validated at the boundary but handed on UNDEFAULTED.
 *
 * The reducer distinguishes an OMITTED assignee — which means "the owning session" — from an explicit
 * `null`, which means "deliberately unassigned". Applying the schema's defaults here collapses the
 * two, because `assignee` defaults to `null`: every task created over HTTP would come out unassigned
 * and "nobody owns this yet" would stop being expressible. So the schema decides whether the body is
 * acceptable, and the raw object is what travels on — the reducer parses it again itself, which is
 * where the presence check belongs.
 */
async function parseCreateBody(request: ApiRequest): Promise<TaskCreateRequestInput> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  const parsed = TaskCreateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // The issue paths name the failing fields without echoing the submitted values, so a rejected
    // description never comes back out in an error message.
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request');
  }
  return raw as TaskCreateRequestInput;
}

/** Creates a task on one session's board. */
async function create(subsystem: TaskSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseCreateBody(context.request);
  const board = boardFor(subsystem, sessionId);
  const entry = await board.create(request, taskActor(context.actor)).catch(reraise);
  const read = await board.list().catch(reraise);
  return jsonResponse(
    scopedView(
      sessionId,
      entry.task,
      read.entries.map(other => other.task),
      await observeAssignees(subsystem, [entry.task]),
    ),
    201,
  );
}

/** Applies one action to one task. */
async function act(subsystem: TaskSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const taskId = pathTaskId(context);
  const request = await parseBody(context.request, TaskActionRequestSchema);
  const board = boardFor(subsystem, sessionId);
  const entry = await board.act(taskId, request, taskActor(context.actor)).catch(reraise);
  const read = await board.list().catch(reraise);
  return jsonResponse(
    scopedView(
      sessionId,
      entry.task,
      read.entries.map(other => other.task),
      await observeAssignees(subsystem, [entry.task]),
    ),
  );
}

/**
 * `admin` scope throughout, which is the conservative reading of a surface a warden can only reach
 * through the daemon's own reconciliation today. A route that says nothing about scope is admin-only
 * by construction, so widening this later is a deliberate edit rather than an oversight.
 *
 * `noStore` because a task board is what a human is watching to know whether work moved; a cached
 * one shows a status that has already changed.
 *
 * The fleet read is registered FIRST so its fixed literal path can never be shadowed by a later
 * pattern, matching the ordering rule the base feeds follow.
 */
export function taskRoutes(subsystem: TaskSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/tasks',
      scope: 'admin',
      noStore: true,
      handle: async context => await listFleet(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/tasks',
      scope: 'admin',
      noStore: true,
      handle: async context => await listSession(subsystem, pathSessionId(context), context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/tasks',
      scope: 'admin',
      noStore: true,
      handle: async context => await create(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/tasks/:taskId',
      scope: 'admin',
      noStore: true,
      handle: async context => await detail(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/tasks/:taskId',
      scope: 'admin',
      noStore: true,
      handle: async context => await act(subsystem, context),
    },
  ];
}
