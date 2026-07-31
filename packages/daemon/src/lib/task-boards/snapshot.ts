import {
  InstantSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  TaskBoardActionSchema,
  TaskBoardGrantRequestStatusSchema,
  TaskBoardInvitationStatusSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { EMPTY_TASK_BOARD_REPOSITORY_STATE, type TaskBoardRepositoryState } from './types.ts';

/**
 * The durable form of the whole board repository, parsed rather than trusted.
 *
 * WHY THE CODEC LIVES IN `src/lib` AND NOT BESIDE THE FILE STORE. `lib/tasks/task-snapshot.ts` is the
 * same decision for the same reason: what a board document may legally contain is a DOMAIN statement,
 * and the file store's only job is to move bytes. A store that owned the schema could not be swapped
 * for a different medium without the rules travelling with it.
 *
 * WHY A DAMAGED DOCUMENT REFUSES INSTEAD OF DEGRADING. The task snapshot drops an unparseable ENTRY
 * and keeps the board, because a task nobody can read costs one row. This document cannot do that:
 * every grant, binding and invitation proof here is a term in an authorization decision, so a
 * partially-read board would authorize against membership it could not see — silently widening
 * access for the coordinator whose grant failed to parse. The whole document parses or the
 * repository refuses to serve, which is the fail-closed direction.
 */

/**
 * A capability hash, as an opaque non-empty string rather than 64 hex characters.
 *
 * `TaskBoardCredentialIssuer.hash` is an INJECTED collaborator: the domain never computes a hash
 * itself, so the digest's width and alphabet belong to whoever the composition root hands over.
 * Pinning SHA-256 hex here would mean a daemon built with a different issuer wrote documents its own
 * repository then refused to parse — a self-inflicted outage in the name of a check that proves
 * nothing the comparison does not already prove: the hash is only ever compared for equality with
 * another hash from the same issuer.
 */
const HASH = z.string().min(1);

const ROLE = z.enum(['read', 'worker', 'coordinator', 'top_agent']);

const ACTIONS = z.array(TaskBoardActionSchema);

const GrantSchema = z.strictObject({
  id: z.string().min(1),
  capabilityHash: HASH,
  sessionId: z.string().min(1),
  sessionIncarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  role: ROLE,
  allowedActions: ACTIONS,
  membershipRootSessionId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable(),
  boardEpoch: NonNegativeIntegerSchema,
  coordinatorEpoch: NonNegativeIntegerSchema,
  active: z.boolean(),
  grantedAt: InstantSchema,
  grantedBySessionId: z.string().min(1).nullable(),
  revokedAt: InstantSchema.optional(),
  revokedBySessionId: z.string().min(1).nullable().optional(),
  revokeReason: z.string().min(1).optional(),
});

/**
 * A binding holds a PLAINTEXT capability, which is why nothing outside the repository ever sees this
 * schema's output whole: the API projects `membershipForGrant`, never a binding.
 */
const BindingSchema = z.strictObject({
  boardId: z.string().min(1),
  grantId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionIncarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  capability: z.string().min(1),
  role: ROLE,
  allowedActions: ACTIONS,
  boardEpoch: NonNegativeIntegerSchema,
  coordinatorEpoch: NonNegativeIntegerSchema,
  updatedAt: InstantSchema,
});

const ChildGrantIntentSchema = z.strictObject({
  requestId: z.string().min(1),
  fingerprint: z.string().min(1),
  boardEpoch: NonNegativeIntegerSchema,
  sourceGrantId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceSessionIncarnation: z.string().min(1),
  sourceRuntimeGeneration: PositiveIntegerSchema,
  membershipRootSessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  targetSessionIncarnation: z.string().min(1),
  targetRuntimeGeneration: PositiveIntegerSchema,
  targetLineage: z.array(z.string().min(1)),
  requestedRole: z.enum(['read', 'worker', 'coordinator']),
  allowedActions: ACTIONS,
  coordinatorGrantId: z.string().min(1),
  coordinatorSessionId: z.string().min(1),
  coordinatorSessionIncarnation: z.string().min(1),
  coordinatorRuntimeGeneration: PositiveIntegerSchema,
  coordinatorLineage: z.array(z.string().min(1)),
  coordinatorEpoch: NonNegativeIntegerSchema,
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
  status: TaskBoardGrantRequestStatusSchema,
  approvedAt: InstantSchema.optional(),
  approvedBySessionId: z.string().min(1).optional(),
  grantId: z.string().min(1).optional(),
  refusalReason: z.string().min(1).optional(),
});

const InvitationSchema = z.strictObject({
  requestId: z.string().min(1),
  fingerprint: z.string().min(1),
  boardEpoch: NonNegativeIntegerSchema,
  sourceGrantId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceSessionIncarnation: z.string().min(1),
  sourceRuntimeGeneration: PositiveIntegerSchema,
  targetSessionId: z.string().min(1),
  targetSessionIncarnation: z.string().min(1),
  targetRuntimeGeneration: PositiveIntegerSchema,
  coordinatorGrantId: z.string().min(1),
  coordinatorSessionId: z.string().min(1),
  coordinatorSessionIncarnation: z.string().min(1),
  coordinatorRuntimeGeneration: PositiveIntegerSchema,
  coordinatorLineage: z.array(z.string().min(1)),
  coordinatorEpoch: NonNegativeIntegerSchema,
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
  status: TaskBoardInvitationStatusSchema,
  approvedAt: InstantSchema.optional(),
  approvedBySessionId: z.string().min(1).optional(),
  acceptanceCapabilityHash: HASH.optional(),
  acceptedAt: InstantSchema.optional(),
  grantId: z.string().min(1).optional(),
  refusalReason: z.string().min(1).optional(),
});

const InvitationProofSchema = z.strictObject({
  boardId: z.string().min(1),
  invitationRequestId: z.string().min(1),
  targetSessionId: z.string().min(1),
  targetSessionIncarnation: z.string().min(1),
  targetRuntimeGeneration: PositiveIntegerSchema,
  sessionCapabilityHash: HASH,
  invitationCapability: z.string().min(1),
  invitationCapabilityHash: HASH,
  expiresAt: InstantSchema,
});

const AuditEntrySchema = z.strictObject({
  sequence: PositiveIntegerSchema,
  at: InstantSchema,
  event: z.enum([
    'board.created',
    'grant.requested',
    'grant.approved',
    'grant.refused',
    'grant.expired',
    'invitation.requested',
    'invitation.approved',
    'invitation.accepted',
    'invitation.refused',
    'invitation.expired',
    'membership.relinquished',
    'coordinator.replaced',
    'grant.revoked',
    'mark-done.changed',
  ]),
  requestId: z.string().min(1),
  actorSessionId: z.string().min(1).nullable(),
  outcome: z.enum(['applied', 'replayed', 'denied']),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

const AppliedOperationSchema = z.strictObject({
  requestId: z.string().min(1),
  kind: z.enum([
    'child-grant.approve',
    'invitation.approve',
    'invitation.accept',
    'membership.relinquish',
    'coordinator.replace',
    'grant.revoke',
    'mark-done.set',
  ]),
  fingerprint: z.string().min(1),
  actorSessionId: z.string().min(1).nullable(),
  actorGrantId: z.string().min(1).nullable(),
  actorRuntimeGeneration: PositiveIntegerSchema.nullable(),
  resultGrantId: z.string().min(1).optional(),
  resultSessionId: z.string().min(1).optional(),
  appliedAt: InstantSchema,
});

const BoardSchema = z.strictObject({
  id: z.string().min(1),
  creatorSessionId: z.string().min(1),
  canonicalSessionId: z.string().min(1),
  coordinatorSessionId: z.string().min(1),
  coordinatorGrantId: z.string().min(1),
  boardEpoch: NonNegativeIntegerSchema,
  coordinatorEpoch: NonNegativeIntegerSchema,
  mutationGeneration: NonNegativeIntegerSchema,
  grants: z.array(GrantSchema),
  childGrantIntents: z.array(ChildGrantIntentSchema),
  invitations: z.array(InvitationSchema),
  appliedOperations: z.array(AppliedOperationSchema),
  audit: z.array(AuditEntrySchema),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});

export const TASK_BOARD_SNAPSHOT_VERSION = 1;

/**
 * The document as it sits on disk. The version is carried so a later shape change is a migration
 * rather than a document that parses into something subtly different.
 */
const TaskBoardSnapshotSchema = z.strictObject({
  version: z.literal(TASK_BOARD_SNAPSHOT_VERSION),
  revision: NonNegativeIntegerSchema,
  boards: z.array(BoardSchema),
  bindings: z.array(BindingSchema),
  invitationProofs: z.array(InvitationProofSchema),
  creations: z.array(
    z.strictObject({
      requestId: z.string().min(1),
      fingerprint: z.string().min(1),
      boardId: z.string().min(1),
    }),
  ),
});

/** A read, or the reason it refused — carried so the refusal can name the failure rather than
 *  degrade into an empty board. */
export type TaskBoardSnapshotRead =
  | { readonly ok: true; readonly state: TaskBoardRepositoryState }
  | { readonly ok: false; readonly failure: { readonly detail: string } };

/** The empty repository, for a home that has never held a board. */
export function emptyTaskBoardState(): TaskBoardRepositoryState {
  return EMPTY_TASK_BOARD_REPOSITORY_STATE;
}

/** Parses a document. A failure names the offending field without echoing its value. */
export function parseTaskBoardSnapshot(text: string): TaskBoardSnapshotRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, failure: { detail: 'the board document is not valid JSON' } };
  }
  const parsed = TaskBoardSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') === '' ? 'document' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { ok: false, failure: { detail } };
  }
  const { version: _version, ...state } = parsed.data;
  return { ok: true, state };
}

/** Serializes the repository. Stable key order, so two identical boards produce identical bytes. */
export function serializeTaskBoardSnapshot(state: TaskBoardRepositoryState): string {
  return `${JSON.stringify({ version: TASK_BOARD_SNAPSHOT_VERSION, ...state }, undefined, 2)}\n`;
}
