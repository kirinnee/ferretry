import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { TASK_SCHEMA_VERSION, TaskSummarySchema } from './tasks.ts';

export const TASK_BOARD_SCHEMA_VERSION = 1 as const;

export const TaskBoardRoleSchema = z.enum(['none', 'read', 'worker', 'coordinator', 'top_agent']);
export type TaskBoardRole = z.infer<typeof TaskBoardRoleSchema>;

export const TaskBoardChildAccessSchema = z.enum(['read', 'worker', 'coordinator']);
export type TaskBoardChildAccess = z.infer<typeof TaskBoardChildAccessSchema>;

export const TaskBoardActionSchema = z.enum([
  'read',
  'create',
  'status',
  'note',
  'feedback',
  'clarify',
  'dependency',
  'file',
  'link',
  'assign',
  'order',
  'mark_done',
  'grant_request',
  'grant_approve',
  'invite_request',
  'invite_approve',
  'invite_accept',
  'membership_relinquish',
  'acl_admin',
]);
export type TaskBoardAction = z.infer<typeof TaskBoardActionSchema>;

/** Public membership projection. Capability material and hashes remain server-side. */
const TASK_BOARD_ROLE_ACTIONS = {
  read: new Set(['read']),
  worker: new Set(['read', 'status', 'note', 'feedback', 'file', 'link']),
  coordinator: new Set([
    'read',
    'create',
    'status',
    'note',
    'feedback',
    'clarify',
    'dependency',
    'file',
    'link',
    'assign',
    'order',
    'grant_approve',
    'invite_approve',
  ]),
  top_agent: new Set([
    'read',
    'create',
    'status',
    'note',
    'feedback',
    'clarify',
    'dependency',
    'file',
    'link',
    'assign',
    'order',
    // Optional at issuance: a top-level agent may mark work done only when
    // its own explicit grant carries this action.
    'mark_done',
    'grant_request',
    'invite_request',
    'membership_relinquish',
  ]),
} satisfies Readonly<Record<Exclude<TaskBoardRole, 'none'>, ReadonlySet<TaskBoardAction>>>;

export const TaskBoardMembershipSchema = z
  .object({
    sessionId: z.string().min(1),
    role: z.enum(['read', 'worker', 'coordinator', 'top_agent']),
    allowedActions: z.array(TaskBoardActionSchema),
    boardEpoch: NonNegativeIntegerSchema,
    coordinatorEpoch: NonNegativeIntegerSchema,
    runtimeGeneration: PositiveIntegerSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.allowedActions).size !== value.allowedActions.length) {
      context.addIssue({ code: 'custom', message: 'allowedActions must be unique', path: ['allowedActions'] });
    }
    const allowed: ReadonlySet<TaskBoardAction> = TASK_BOARD_ROLE_ACTIONS[value.role];
    if (value.allowedActions.some(action => !allowed.has(action))) {
      context.addIssue({ code: 'custom', message: 'allowedActions contains an action outside the role' });
    }
  });
export type TaskBoardMembership = z.infer<typeof TaskBoardMembershipSchema>;

export const TaskBoardGrantRequestStatusSchema = z.enum(['pending', 'approved', 'refused', 'expired']);
export type TaskBoardGrantRequestStatus = z.infer<typeof TaskBoardGrantRequestStatusSchema>;

const TaskBoardGrantRequestBaseShape = {
  requestId: z.string().min(1),
  targetSessionId: z.string().min(1),
  requestedRole: TaskBoardChildAccessSchema,
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
};

export const TaskBoardGrantRequestViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...TaskBoardGrantRequestBaseShape, status: z.literal('pending') }),
  z.strictObject({ ...TaskBoardGrantRequestBaseShape, status: z.literal('approved') }),
  z.strictObject({ ...TaskBoardGrantRequestBaseShape, status: z.literal('expired') }),
  z.strictObject({
    ...TaskBoardGrantRequestBaseShape,
    status: z.literal('refused'),
    refusalReason: z.string().min(1),
  }),
]);
export type TaskBoardGrantRequestView = z.infer<typeof TaskBoardGrantRequestViewSchema>;

export const TaskBoardInvitationStatusSchema = z.enum(['pending', 'approved', 'accepted', 'refused', 'expired']);
export type TaskBoardInvitationStatus = z.infer<typeof TaskBoardInvitationStatusSchema>;

const TaskBoardInvitationBaseShape = {
  requestId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
};

export const TaskBoardInvitationViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...TaskBoardInvitationBaseShape, status: z.literal('pending') }),
  z.strictObject({ ...TaskBoardInvitationBaseShape, status: z.literal('approved') }),
  z.strictObject({ ...TaskBoardInvitationBaseShape, status: z.literal('accepted') }),
  z.strictObject({ ...TaskBoardInvitationBaseShape, status: z.literal('expired') }),
  z.strictObject({
    ...TaskBoardInvitationBaseShape,
    status: z.literal('refused'),
    refusalReason: z.string().min(1),
  }),
]);
export type TaskBoardInvitationView = z.infer<typeof TaskBoardInvitationViewSchema>;

export const TaskBoardCreateRequestSchema = z.strictObject({
  creatorSessionId: z.string().min(1),
  coordinatorSessionId: z.string().min(1),
  creatorMarkDone: z.boolean().optional(),
});
export type TaskBoardCreateRequest = z.infer<typeof TaskBoardCreateRequestSchema>;

export const TaskBoardCreateResponseSchema = z.object({
  created: z.boolean(),
  creator: TaskBoardMembershipSchema,
  coordinator: TaskBoardMembershipSchema,
});
export type TaskBoardCreateResponse = z.infer<typeof TaskBoardCreateResponseSchema>;

export const TaskBoardChildGrantRequestSchema = z.strictObject({
  targetSessionId: z.string().min(1),
  role: TaskBoardChildAccessSchema,
});
export type TaskBoardChildGrantRequest = z.infer<typeof TaskBoardChildGrantRequestSchema>;

export const TaskBoardChildGrantApprovalSchema = z.strictObject({
  grantRequestId: z.string().min(1),
});
export type TaskBoardChildGrantApproval = z.infer<typeof TaskBoardChildGrantApprovalSchema>;

export const TaskBoardInvitationRequestSchema = z.strictObject({
  targetSessionId: z.string().min(1),
});
export type TaskBoardInvitationRequest = z.infer<typeof TaskBoardInvitationRequestSchema>;

export const TaskBoardInvitationApprovalSchema = z.strictObject({
  invitationRequestId: z.string().min(1),
});
export type TaskBoardInvitationApproval = z.infer<typeof TaskBoardInvitationApprovalSchema>;

export const TaskBoardMarkDoneRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  enabled: z.boolean(),
});
export type TaskBoardMarkDoneRequest = z.infer<typeof TaskBoardMarkDoneRequestSchema>;

export const TaskBoardCoordinatorReplacementSchema = z.strictObject({
  requestId: z.string().trim().min(1),
  sessionId: z.string().min(1),
  replacementSessionId: z.string().min(1),
  replacementRootSessionId: z.string().min(1),
});
export type TaskBoardCoordinatorReplacement = z.infer<typeof TaskBoardCoordinatorReplacementSchema>;

export const TaskBoardGrantRevocationSchema = z.strictObject({
  sessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  reason: z.string().min(1),
});
export type TaskBoardGrantRevocation = z.infer<typeof TaskBoardGrantRevocationSchema>;

export const TaskBoardInvitationAcceptRequestSchema = z.strictObject({});
export type TaskBoardInvitationAcceptRequest = z.infer<typeof TaskBoardInvitationAcceptRequestSchema>;

export const TaskBoardMembershipRelinquishRequestSchema = z.strictObject({});
export type TaskBoardMembershipRelinquishRequest = z.infer<typeof TaskBoardMembershipRelinquishRequestSchema>;

export const TaskBoardRelinquishResponseSchema = z.object({
  relinquished: z.literal(true),
  sessionId: z.string().min(1),
  sessionStopped: z.literal(false),
});
export type TaskBoardRelinquishResponse = z.infer<typeof TaskBoardRelinquishResponseSchema>;

export const TaskBoardRevokeResponseSchema = z.object({
  revoked: z.literal(true),
  targetSessionId: z.string().min(1),
});
export type TaskBoardRevokeResponse = z.infer<typeof TaskBoardRevokeResponseSchema>;

export const TaskBoardErrorCodeSchema = z.enum([
  'invalid',
  'not-found',
  'forbidden',
  'conflict',
  'stale-epoch',
  'stale-generation',
  'read-only',
  'unavailable',
]);
export type TaskBoardErrorCode = z.infer<typeof TaskBoardErrorCodeSchema>;

/**
 * ─── The board-scoped task aggregate ────────────────────────────────────────────────────────────
 *
 * The wire shape of "every task on the board I am reading", answered by one session-scoped route.
 *
 * ## WHY THIS IS NOT `FleetTaskListResponse`, AND WHY THAT MATTERS MORE THAN IT LOOKS
 *
 * A shared board is NOT a union of per-session task files. Task ids are allocated inside each
 * session's own board and start at 1, so several members can each hold an `F1` naming completely
 * different work. `FleetTaskListResponse` is defined as the session response with `sessionId: null` —
 * its whole identity is "no scope" — and a caller that keys anything by task id alone will silently
 * merge two members' rows. Every row here therefore carries a NON-NULLABLE `sessionId`, and the
 * identity of a row is the pair `{sessionId, id}`, never `id`.
 *
 * `ScopedTaskSummary.sessionId` is nullable for the fleet read's sake, which forces its consumers to
 * re-assert a scope they already knew. That workaround is the tell that the fact had no owner; this
 * schema is the owner, so nothing downstream needs to repair the value it was handed.
 *
 * ## STRICTNESS, STATED RATHER THAN ASSUMED
 *
 * The envelope, the viewer arms and a member entry are `strictObject`: they are new shapes owned
 * entirely here, and an unexpected key in one of them is a defect worth refusing. {@link
 * BoardTaskRowSchema} is NOT strict, because it extends `TaskSummarySchema`, which is not — making
 * the row strict would mean restating the whole task summary here, which is exactly the second
 * definition this file exists to avoid.
 */

/**
 * A role a board member can actually hold, DERIVED from the role enum rather than respelled.
 *
 * `none` is not a membership — a member entry exists only for an active grant — so a schema that
 * admitted it would make an unrepresentable state representable. Deriving with `.exclude` rather than
 * writing the four names again means a new role cannot appear in one list and be forgotten in the
 * other.
 */
export const TaskBoardActiveRoleSchema = TaskBoardRoleSchema.exclude(['none']);
export type TaskBoardActiveRole = z.infer<typeof TaskBoardActiveRoleSchema>;

/**
 * One session on the board, as a reader needs to name it.
 *
 * `name` is nullable because a session may genuinely have none; a caller renders the id in that case
 * rather than inventing a label. `active` is the session's liveness, not the grant's: a stopped
 * member still owns its rows and they are still the board's work.
 */
export const BoardMemberSchema = z.strictObject({
  sessionId: z.string().min(1),
  name: z.string().nullable(),
  role: TaskBoardActiveRoleSchema,
  active: z.boolean(),
});
export type BoardMember = z.infer<typeof BoardMemberSchema>;

/**
 * One task on the board, owned by exactly one member session.
 *
 * `actions` is what THIS caller may do to THIS row, computed by the daemon from the caller's grant
 * (or, for the operator, from the row's own phase) and shipped so a surface can DISABLE rather than
 * offer-then-fail. It is deliberately a list of permitted actions and never a capability, a grant id
 * or an authorization record: those are write-path outputs, and putting one on a read row is the
 * first step towards a client deriving its own authority.
 */
export const BoardTaskRowSchema = TaskSummarySchema.safeExtend({
  sessionId: z.string().min(1),
  sessionName: z.string().nullable(),
  actions: z.array(TaskBoardActionSchema),
}).superRefine((value, context) => {
  // A set of permissions, expressed as a list. A repeat is a server defect rather than a caller's
  // mistake, and it is the same rule `TaskBoardMembershipSchema` applies to `allowedActions`.
  if (new Set(value.actions).size !== value.actions.length) {
    context.addIssue({ code: 'custom', message: 'actions must be unique', path: ['actions'] });
  }
});
export type BoardTaskRow = z.infer<typeof BoardTaskRowSchema>;

/**
 * WHO IS READING, as a union — because the operator is not a member and must not be dressed as one.
 *
 * A board member is described by its grant. The human operator holds no grant, no role, no allowed
 * actions and no runtime generation, and `TaskBoardMembershipSchema` cannot express that: its role
 * list has no `human_admin` and its refinement demands the allowed actions sit inside the role. The
 * alternative — adding `human_admin` to the board role enum — would put a non-role in
 * `TASK_BOARD_ROLE_ACTIONS`, in every grant that carries a role, and in every closed-set check that
 * enumerates them, to describe a caller that has no grant at all.
 *
 * So the operator arm carries NOTHING beyond its discriminator. That is not a stub awaiting fields:
 * it is the complete truth about a reader who is outside the membership model. Note that this
 * `human_admin` is a *viewer kind* and shares only a spelling with `TaskAuthorizationProvenance`'s
 * role of the same name — the operator's completions write no authorization record, so nothing here
 * ever populates that one.
 */
export const BoardViewerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), membership: TaskBoardMembershipSchema }),
  z.strictObject({ kind: z.literal('human_admin') }),
]);
export type BoardViewer = z.infer<typeof BoardViewerSchema>;

/**
 * Every task on one board, with the board's own identity and the reader's standing on it.
 *
 * `boardId` is an OUTPUT and never an input: the route is scoped by the session in its path, so a
 * caller that cannot name a board cannot ask for the wrong one. The epochs are the BOARD's, not the
 * caller's, so both viewer arms carry them — a reader with no grant still needs to know the board
 * moved underneath a list it is holding.
 *
 * `v` is the TASK schema version rather than the board's, because what versions this payload is the
 * shape of its rows.
 */
export const BoardTaskListResponseSchema = z.strictObject({
  v: z.literal(TASK_SCHEMA_VERSION),
  boardId: z.string().min(1),
  boardEpoch: NonNegativeIntegerSchema,
  coordinatorEpoch: NonNegativeIntegerSchema,
  viewer: BoardViewerSchema,
  members: z.array(BoardMemberSchema),
  rows: z.array(BoardTaskRowSchema),
  updatedAt: InstantSchema,
});
export type BoardTaskListResponse = z.infer<typeof BoardTaskListResponseSchema>;
