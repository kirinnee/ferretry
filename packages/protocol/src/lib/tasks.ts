import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { SessionStatusSchema } from './session.ts';

export const TASK_SCHEMA_VERSION = 1 as const;
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 64 * 1024;
export const MAX_TASK_NOTE_LENGTH = 2 * 1024;
export const MAX_TASK_LINK_LENGTH = 512;
export const MAX_TASK_LINKS_PER_FIELD = 64;
export const MAX_TASK_SOURCE_LENGTH = 2 * 1024;
export const MAX_TASK_CLARIFICATIONS = 128;
export const MAX_TASK_DEPENDENCIES = 128;
export const MAX_TASK_FILES = 256;
export const MAX_TASK_FILE_LENGTH = 1024;

export const TaskKindSchema = z.enum(['bug', 'feature', 'infra', 'chore']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

const TASK_KIND_PREFIX: Readonly<Record<TaskKind, string>> = {
  bug: 'B',
  feature: 'F',
  infra: 'I',
  chore: 'C',
};

export const TaskIdSchema = z.string().regex(/^[BFIC][1-9][0-9]{0,8}$/u);
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TaskTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TASK_TITLE_LENGTH)
  .refine(value => value.split(/\s+/u).length <= 5, 'title must contain at most five words');
export type TaskTitle = z.infer<typeof TaskTitleSchema>;

export const TaskStatusSchema = z.enum([
  'todo',
  'researched',
  'designed',
  'in_progress',
  'built',
  'live',
  'done',
  'blocked',
  'dropped',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPhaseSchema = z.enum(['todo', 'research', 'design', 'build', 'built', 'live', 'done', 'dropped']);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TaskBoardLaneSchema = z.enum(['todo', 'in_progress', 'built', 'live', 'done', 'dropped']);
export type TaskBoardLane = z.infer<typeof TaskBoardLaneSchema>;

export const TaskWorkflowSchema = z.enum(['quick', 'design-first', 'research-first', 'investigate']);
export type TaskWorkflow = z.infer<typeof TaskWorkflowSchema>;

const TASK_WORKFLOW_PHASES: Readonly<Record<TaskWorkflow, readonly TaskPhase[]>> = {
  quick: ['todo', 'build', 'built', 'live', 'done'],
  'design-first': ['todo', 'design', 'build', 'built', 'live', 'done'],
  'research-first': ['todo', 'research', 'design', 'build', 'built', 'live', 'done'],
  investigate: ['todo', 'research', 'done'],
};

const TASK_STATUS_PHASE: Readonly<Record<Exclude<TaskStatus, 'blocked'>, TaskPhase>> = {
  todo: 'todo',
  researched: 'research',
  designed: 'design',
  in_progress: 'build',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
};

export const TaskMessageSchema = z.object({
  text: z.string().min(1).max(MAX_TASK_DESCRIPTION_LENGTH),
  source: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;

export const TaskClarificationSchema = TaskMessageSchema.extend({
  at: InstantSchema,
  by: z.string().min(1),
  byName: z.string().nullable(),
});
export type TaskClarification = z.infer<typeof TaskClarificationSchema>;

export const TaskLinksSchema = z.object({
  prs: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD),
  branch: z.string().min(1).max(MAX_TASK_LINK_LENGTH).nullable(),
  commits: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD),
  docs: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD),
});
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

export const TaskLinkFieldSchema = z.enum(['pr', 'branch', 'commit', 'doc']);
export type TaskLinkField = z.infer<typeof TaskLinkFieldSchema>;

const TaskBaseSchema = z.object({
  v: z.literal(TASK_SCHEMA_VERSION),
  id: TaskIdSchema,
  kind: TaskKindSchema,
  title: TaskTitleSchema,
  description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH),
  ask: TaskMessageSchema,
  clarifications: z.array(TaskClarificationSchema).max(MAX_TASK_CLARIFICATIONS),
  workflow: TaskWorkflowSchema,
  phase: TaskPhaseSchema,
  dependsOn: z.array(TaskIdSchema).max(MAX_TASK_DEPENDENCIES),
  status: TaskStatusSchema,
  statusReason: z.string().trim().min(1).max(MAX_TASK_NOTE_LENGTH).nullable(),
  assignee: z.string().min(1).nullable(),
  repo: z.string().min(1).nullable(),
  files: z.array(z.string().min(1).max(MAX_TASK_FILE_LENGTH)).max(MAX_TASK_FILES),
  links: TaskLinksSchema,
  order: z.number().int().nonnegative().nullable(),
  reopenAckSeq: PositiveIntegerSchema.optional(),
  createdAt: InstantSchema,
  createdBy: z.string().nullable(),
  updatedAt: InstantSchema,
});

type TaskCoherence = Pick<
  z.infer<typeof TaskBaseSchema>,
  'id' | 'kind' | 'workflow' | 'phase' | 'status' | 'statusReason'
>;

const refineTaskCoherence = (value: TaskCoherence, context: z.RefinementCtx): void => {
  if (!value.id.startsWith(TASK_KIND_PREFIX[value.kind])) {
    context.addIssue({ code: 'custom', message: 'task id prefix must match its kind', path: ['id'] });
  }
  if ((value.status === 'blocked' || value.status === 'dropped') && value.statusReason === null) {
    context.addIssue({ code: 'custom', message: 'statusReason is required for this status', path: ['statusReason'] });
  }
  if (value.phase !== 'dropped' && !TASK_WORKFLOW_PHASES[value.workflow].includes(value.phase)) {
    context.addIssue({ code: 'custom', message: 'phase is not part of the selected workflow', path: ['phase'] });
  }
  if (value.status !== 'blocked' && TASK_STATUS_PHASE[value.status] !== value.phase) {
    context.addIssue({ code: 'custom', message: 'status and phase must describe the same state', path: ['phase'] });
  }
};

export const TaskSchema = TaskBaseSchema.superRefine(refineTaskCoherence);
export type Task = z.infer<typeof TaskSchema>;

export const TaskAuthorizationProvenanceSchema = z.object({
  boardId: z.string().optional(),
  role: z.enum(['read', 'worker', 'coordinator', 'top_agent', 'human_admin', 'daemon']),
  boardEpoch: NonNegativeIntegerSchema,
  coordinatorEpoch: NonNegativeIntegerSchema,
  runtimeGeneration: PositiveIntegerSchema.nullable(),
  action: z.string().min(1),
  requestId: z.string().min(1),
});
export type TaskAuthorizationProvenance = z.infer<typeof TaskAuthorizationProvenanceSchema>;

export const TaskActivityTypeSchema = z.enum([
  'created',
  'status',
  'note',
  'link',
  'assign',
  'order',
  'feedback',
  'clarification',
  'dependency',
  'file',
  'session',
]);
export type TaskActivityType = z.infer<typeof TaskActivityTypeSchema>;

const TaskActivityBaseShape = {
  v: z.literal(TASK_SCHEMA_VERSION),
  seq: PositiveIntegerSchema,
  time: InstantSchema,
  actor: z.string().min(1),
  actorName: z.string().nullable(),
};

const TaskActivityAuthorizationShape = {
  authorization: TaskAuthorizationProvenanceSchema.optional(),
};

const CreatedTaskActivitySchema = z.object({
  ...TaskActivityBaseShape,
  type: z.literal('created'),
  data: z.object({
    status: TaskStatusSchema,
    phase: TaskPhaseSchema,
    workflow: TaskWorkflowSchema,
    kind: TaskKindSchema,
    title: TaskTitleSchema,
    askSource: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
    dependsOn: z.array(TaskIdSchema).max(MAX_TASK_DEPENDENCIES),
    files: z.array(z.string().min(1).max(MAX_TASK_FILE_LENGTH)).max(MAX_TASK_FILES).optional(),
    reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH),
    assignee: z.string().min(1).optional(),
  }),
});

const StatusTaskActivitySchema = z.object({
  ...TaskActivityBaseShape,
  type: z.literal('status'),
  data: z.object({
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    phaseFrom: TaskPhaseSchema,
    phaseTo: TaskPhaseSchema,
    reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH),
    note: z.string().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
    backward: z.literal(true).optional(),
    reopened: z.literal(true).optional(),
    approvedByHuman: z.literal(true).optional(),
    verifiedByHuman: z.literal(true).optional(),
    verifiedByTopAgent: z.literal(true).optional(),
    completionClaim: z.literal(true).optional(),
    ...TaskActivityAuthorizationShape,
  }),
});

const NoteTaskActivityDataSchema = z.object({
  text: z.string().min(1).max(MAX_TASK_NOTE_LENGTH),
  ...TaskActivityAuthorizationShape,
});

const SessionTaskActivityDataSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('completion-claim'),
    session: z.string().min(1),
    turn: NonNegativeIntegerSchema,
    phase: TaskPhaseSchema,
    claimedAt: InstantSchema,
    advancesTo: TaskPhaseSchema.optional(),
    ...TaskActivityAuthorizationShape,
  }),
  z.object({
    event: z.literal('reopen-ack'),
    reopenAck: PositiveIntegerSchema,
    resolvedBy: z.string().min(1),
    resolvedByName: z.string().nullable(),
    note: z.string().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
    ...TaskActivityAuthorizationShape,
  }),
]);

export const TaskActivitySchema = z.discriminatedUnion('type', [
  CreatedTaskActivitySchema,
  StatusTaskActivitySchema,
  z.object({ ...TaskActivityBaseShape, type: z.literal('note'), data: NoteTaskActivityDataSchema }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('link'),
    data: z.object({
      field: TaskLinkFieldSchema,
      value: z.string().min(1).max(MAX_TASK_LINK_LENGTH),
      ...TaskActivityAuthorizationShape,
    }),
  }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('assign'),
    data: z.object({ from: z.string().nullable(), to: z.string().nullable(), ...TaskActivityAuthorizationShape }),
  }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('order'),
    data: z.object({
      from: NonNegativeIntegerSchema.nullable(),
      to: NonNegativeIntegerSchema.nullable(),
      ...TaskActivityAuthorizationShape,
    }),
  }),
  z.object({ ...TaskActivityBaseShape, type: z.literal('feedback'), data: NoteTaskActivityDataSchema }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('clarification'),
    data: z.object({
      text: z.string().min(1).max(MAX_TASK_DESCRIPTION_LENGTH),
      source: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
      ...TaskActivityAuthorizationShape,
    }),
  }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('dependency'),
    data: z.object({
      taskId: TaskIdSchema,
      operation: z.enum(['add', 'remove']),
      ...TaskActivityAuthorizationShape,
    }),
  }),
  z.object({
    ...TaskActivityBaseShape,
    type: z.literal('file'),
    data: z.object({
      path: z.string().min(1).max(MAX_TASK_FILE_LENGTH),
      operation: z.enum(['add', 'remove']),
      reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
      ...TaskActivityAuthorizationShape,
    }),
  }),
  z.object({ ...TaskActivityBaseShape, type: z.literal('session'), data: SessionTaskActivityDataSchema }),
]);
export type TaskActivity = z.infer<typeof TaskActivitySchema>;

export const TaskAssigneeHealthSchema = z.enum(['active', 'waiting', 'dead', 'unknown']);
export type TaskAssigneeHealth = z.infer<typeof TaskAssigneeHealthSchema>;

export const TaskStalenessSchema = z.enum(['assignee-dead', 'maybe-finished', 'quiet']);
export type TaskStaleness = z.infer<typeof TaskStalenessSchema>;

export const TaskLiveSchema = z.object({
  assigneeSessionId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  assigneeStatus: SessionStatusSchema.nullable(),
  assigneeHealth: TaskAssigneeHealthSchema.nullable(),
  assigneeDoneMarker: z.boolean(),
  assigneeLastActivityAt: InstantSchema.nullable(),
  staleness: TaskStalenessSchema.nullable(),
});
export type TaskLive = z.infer<typeof TaskLiveSchema>;

const TaskViewShape = {
  live: TaskLiveSchema,
  blocked: z.boolean(),
  blockedReason: z.string().nullable(),
  blockedSince: InstantSchema.nullable(),
  blockedBy: z.array(TaskIdSchema),
};

export const TaskViewSchema = TaskSchema.safeExtend(TaskViewShape);
export type TaskView = z.infer<typeof TaskViewSchema>;

export const ScopedTaskViewSchema = TaskViewSchema.safeExtend({
  sessionId: z.string().min(1),
  authorization: TaskAuthorizationProvenanceSchema.optional(),
});
export type ScopedTaskView = z.infer<typeof ScopedTaskViewSchema>;

export const TaskSummarySchema = TaskBaseSchema.omit({ description: true, ask: true, clarifications: true })
  .extend({
    ...TaskViewShape,
    descriptionChars: NonNegativeIntegerSchema,
    askChars: NonNegativeIntegerSchema,
    askSource: z.string(),
    clarificationCount: NonNegativeIntegerSchema,
  })
  .superRefine(refineTaskCoherence);
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const ScopedTaskSummarySchema = TaskSummarySchema.safeExtend({
  sessionId: z.string().nullable(),
});
export type ScopedTaskSummary = z.infer<typeof ScopedTaskSummarySchema>;

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  parseErrors: NonNegativeIntegerSchema,
  parseErrorIds: z.array(z.string()).optional(),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskDetailResponseSchema = z.object({
  task: TaskViewSchema,
  activity: z.array(TaskActivitySchema),
  activityParseErrors: NonNegativeIntegerSchema.optional(),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

export const SessionTaskListResponseSchema = z.object({
  v: z.literal(TASK_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  tasks: z.array(ScopedTaskSummarySchema),
  parseErrors: NonNegativeIntegerSchema,
  parseErrorIds: z.array(z.string()).optional(),
  updatedAt: InstantSchema,
  authorization: TaskAuthorizationProvenanceSchema.optional(),
});
export type SessionTaskListResponse = z.infer<typeof SessionTaskListResponseSchema>;

export const FleetTaskListResponseSchema = SessionTaskListResponseSchema.extend({
  sessionId: z.null(),
});
export type FleetTaskListResponse = z.infer<typeof FleetTaskListResponseSchema>;

export const ScopedTaskDetailResponseSchema = z.object({
  sessionId: z.string().nullable(),
  task: TaskViewSchema.safeExtend({ sessionId: z.string().nullable() }),
  activity: z.array(TaskActivitySchema),
  activityParseErrors: NonNegativeIntegerSchema.optional(),
  authorization: TaskAuthorizationProvenanceSchema.optional(),
});
export type ScopedTaskDetailResponse = z.infer<typeof ScopedTaskDetailResponseSchema>;

const PartialTaskLinksSchema = z.strictObject({
  prs: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD).optional(),
  branch: z.string().min(1).max(MAX_TASK_LINK_LENGTH).nullable().optional(),
  commits: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD).optional(),
  docs: z.array(z.string().min(1).max(MAX_TASK_LINK_LENGTH)).max(MAX_TASK_LINKS_PER_FIELD).optional(),
});

/** Transport create shape. Actor metadata and compatibility-only phase overrides are excluded. */
export const TaskCreateRequestSchema = z
  .strictObject({
    kind: TaskKindSchema,
    title: TaskTitleSchema,
    description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH).default(''),
    ask: TaskMessageSchema,
    workflow: TaskWorkflowSchema.default('quick'),
    dependsOn: z.array(TaskIdSchema).max(MAX_TASK_DEPENDENCIES).default([]),
    files: z.array(z.string().min(1).max(MAX_TASK_FILE_LENGTH)).max(MAX_TASK_FILES).default([]),
    status: TaskStatusSchema.default('todo'),
    statusReason: z.string().trim().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
    assignee: z.string().min(1).nullable().default(null),
    repo: z.string().min(1).nullable().default(null),
    links: PartialTaskLinksSchema.default({}),
    order: z.number().int().nonnegative().nullable().default(null),
  })
  .superRefine((value, context) => {
    if ((value.status === 'blocked' || value.status === 'dropped') && value.statusReason === undefined) {
      context.addIssue({ code: 'custom', message: 'statusReason is required for this status', path: ['statusReason'] });
    }
    const phase = value.status === 'blocked' ? 'todo' : TASK_STATUS_PHASE[value.status];
    if (phase !== 'dropped' && !TASK_WORKFLOW_PHASES[value.workflow].includes(phase)) {
      context.addIssue({ code: 'custom', message: 'status is not part of the selected workflow', path: ['status'] });
    }
  });
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;
export type TaskCreateRequestInput = z.input<typeof TaskCreateRequestSchema>;

export const TaskActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('status'),
    status: TaskStatusSchema,
    reason: z.string().trim().min(1).max(MAX_TASK_NOTE_LENGTH),
    note: z.string().trim().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
  }),
  z.strictObject({
    action: z.literal('phase'),
    phase: TaskPhaseSchema,
    reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH),
  }),
  z.strictObject({
    action: z.literal('reopen'),
    reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH),
    ask: z.string().min(1).max(MAX_TASK_DESCRIPTION_LENGTH),
    source: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
  }),
  z.strictObject({ action: z.literal('note'), text: z.string().min(1).max(MAX_TASK_NOTE_LENGTH) }),
  z.strictObject({ action: z.literal('feedback'), text: z.string().min(1).max(MAX_TASK_NOTE_LENGTH) }),
  z.strictObject({
    action: z.literal('clarify'),
    text: z.string().min(1).max(MAX_TASK_DESCRIPTION_LENGTH),
    source: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
  }),
  z.strictObject({ action: z.literal('dependency'), taskId: TaskIdSchema, remove: z.boolean().optional() }),
  z.strictObject({
    action: z.literal('file'),
    path: z.string().min(1).max(MAX_TASK_FILE_LENGTH),
    remove: z.boolean().optional(),
    reason: z.string().min(1).max(MAX_TASK_NOTE_LENGTH).optional(),
  }),
  z.strictObject({
    action: z.literal('link'),
    field: TaskLinkFieldSchema,
    value: z.string().min(1).max(MAX_TASK_LINK_LENGTH),
  }),
  z.strictObject({ action: z.literal('assign'), assignee: z.string().min(1).nullable() }),
  z.strictObject({ action: z.literal('order'), order: z.number().int().nonnegative().nullable() }),
]);
export type TaskActionRequest = z.infer<typeof TaskActionRequestSchema>;

export const TaskErrorCodeSchema = z.enum([
  'invalid',
  'too-long',
  'reason-required',
  'not-found',
  'forbidden',
  'ambiguous',
  'transition',
  'approval-required',
  'cycle',
  'dependency-conflict',
  'read-only',
]);
export type TaskErrorCode = z.infer<typeof TaskErrorCodeSchema>;
