import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

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
  sessionId: z.string().min(1),
  replacementSessionId: z.string().min(1),
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
