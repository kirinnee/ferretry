import { randomUUID } from 'node:crypto';
import {
  type TaskBoardChildAccess,
  TaskBoardChildAccessSchema,
  type TaskBoardChildGrantApproval,
  TaskBoardChildGrantApprovalSchema,
  type TaskBoardChildGrantRequest,
  TaskBoardChildGrantRequestSchema,
  type TaskBoardCoordinatorReplacement,
  TaskBoardCoordinatorReplacementSchema,
  type TaskBoardCreateRequest,
  TaskBoardCreateRequestSchema,
  type TaskBoardGrantRevocation,
  TaskBoardGrantRevocationSchema,
  type TaskBoardInvitationApproval,
  TaskBoardInvitationApprovalSchema,
  type TaskBoardInvitationRequest,
  TaskBoardInvitationRequestSchema,
  type TaskBoardMarkDoneRequest,
  TaskBoardMarkDoneRequestSchema,
} from '@ferretry/protocol';
import { refuse } from '../tasks/errors';

/**
 * Every board command, already validated against its wire schema.
 *
 * No variant carries a board id, and none ever will: a peer authenticates with the capability the
 * daemon issued to its own session, so naming someone else's board is not a thing the CLI can do.
 */
export type TaskBoardCommand =
  | { readonly command: 'membership' }
  | { readonly command: 'create'; readonly body: TaskBoardCreateRequest }
  | { readonly command: 'grant-request'; readonly body: TaskBoardChildGrantRequest }
  | { readonly command: 'grant-approve'; readonly body: TaskBoardChildGrantApproval }
  | { readonly command: 'invite'; readonly body: TaskBoardInvitationRequest }
  | { readonly command: 'invite-approve'; readonly body: TaskBoardInvitationApproval }
  | { readonly command: 'invite-accept' }
  | { readonly command: 'invite-verify' }
  | { readonly command: 'relinquish' }
  | { readonly command: 'mark-done'; readonly body: TaskBoardMarkDoneRequest }
  | { readonly command: 'coordinator-replace'; readonly body: TaskBoardCoordinatorReplacement }
  | { readonly command: 'revoke'; readonly body: TaskBoardGrantRevocation };

/**
 * The wire schema is the last word on a payload's shape, but it is not the caller's error message:
 * `required` refuses first, in the words of the flag that was missing, so the schema only ever sees
 * a well-formed candidate and a zod failure would mean a defect here rather than a user mistake.
 */
const required = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? refuse(`${label} is required`) : trimmed;
};

export function membershipCommand(): TaskBoardCommand {
  return { command: 'membership' };
}

export function createBoardCommand(options: {
  readonly creator?: string;
  readonly coordinator?: string;
  readonly markDone?: boolean;
}): TaskBoardCommand {
  const body = TaskBoardCreateRequestSchema.parse({
    creatorSessionId: required(options.creator, '--creator'),
    coordinatorSessionId: required(options.coordinator, '--coordinator'),
    creatorMarkDone: options.markDone === true,
  });
  return { command: 'create', body };
}

export function grantRequestCommand(child: string, options: { readonly role?: string }): TaskBoardCommand {
  const role = required(options.role, '--role');
  if (!(TaskBoardChildAccessSchema.options as readonly string[]).includes(role)) {
    refuse(`--role must be one of ${TaskBoardChildAccessSchema.options.join(', ')}, got "${role}"`);
  }
  const body = TaskBoardChildGrantRequestSchema.parse({
    targetSessionId: required(child, 'the child session'),
    role: role as TaskBoardChildAccess,
  });
  return { command: 'grant-request', body };
}

export function grantApproveCommand(grantRequestId: string): TaskBoardCommand {
  const body = TaskBoardChildGrantApprovalSchema.parse({
    grantRequestId: required(grantRequestId, 'the grant request id'),
  });
  return { command: 'grant-approve', body };
}

export function inviteCommand(target: string): TaskBoardCommand {
  const body = TaskBoardInvitationRequestSchema.parse({ targetSessionId: required(target, 'the external session') });
  return { command: 'invite', body };
}

export function inviteApproveCommand(invitationRequestId: string): TaskBoardCommand {
  const body = TaskBoardInvitationApprovalSchema.parse({
    invitationRequestId: required(invitationRequestId, 'the invitation request id'),
  });
  return { command: 'invite-approve', body };
}

export function inviteAcceptCommand(): TaskBoardCommand {
  return { command: 'invite-accept' };
}

/** Records that an invited replacement can actually use the board capability it accepted. */
export function inviteVerifyCommand(): TaskBoardCommand {
  return { command: 'invite-verify' };
}

export function relinquishCommand(): TaskBoardCommand {
  return { command: 'relinquish' };
}

export function markDoneCommand(
  sessionId: string,
  options: { readonly enable?: boolean; readonly disable?: boolean },
): TaskBoardCommand {
  if ((options.enable === true) === (options.disable === true)) {
    refuse('mark-done requires exactly one of --enable or --disable');
  }
  const body = TaskBoardMarkDoneRequestSchema.parse({
    sessionId: required(sessionId, 'the top-level session'),
    enabled: options.enable === true,
  });
  return { command: 'mark-done', body };
}

/**
 * One logical replacement attempt. A saga passes its persisted id back on retry; an ordinary CLI
 * invocation mints the id once while building the command, and every transport retry reuses its body.
 */
export function coordinatorReplaceCommand(
  sessionId: string,
  replacement: string,
  replacementRoot: string,
  requestId: string = randomUUID(),
): TaskBoardCommand {
  const body = TaskBoardCoordinatorReplacementSchema.parse({
    requestId: required(requestId, 'the replacement request id'),
    sessionId: required(sessionId, 'the current board member'),
    replacementSessionId: required(replacement, 'the replacement session'),
    replacementRootSessionId: required(replacementRoot, 'the replacement membership root'),
  });
  return { command: 'coordinator-replace', body };
}

export function revokeCommand(
  sessionId: string,
  target: string,
  options: { readonly reason?: string },
): TaskBoardCommand {
  const body = TaskBoardGrantRevocationSchema.parse({
    sessionId: required(sessionId, 'the current board member'),
    targetSessionId: required(target, 'the target session'),
    reason: required(options.reason, '--reason'),
  });
  return { command: 'revoke', body };
}
