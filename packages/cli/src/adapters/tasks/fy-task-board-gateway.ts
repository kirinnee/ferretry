import {
  type IFyApiClient,
  TaskBoardCreateResponseSchema,
  TaskBoardGrantRequestViewSchema,
  TaskBoardInvitationViewSchema,
  TaskBoardMembershipSchema,
  TaskBoardRelinquishResponseSchema,
  TaskBoardRevokeResponseSchema,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { ITaskBoardGateway } from '../../lib/task-boards/board-controller';
import type { TaskBoardCommand } from '../../lib/task-boards/board-command';

export const TASK_BOARD_ROUTE_PREFIX = '/v1/task-boards';

interface Route {
  readonly path: string;
  readonly schema: z.ZodType<unknown>;
  readonly body?: unknown;
}

/**
 * The board surface of the daemon's HTTP API. Every route is a POST except the membership read, and
 * every one of them is answered into a protocol schema rather than trusted as JSON.
 */
function route(command: TaskBoardCommand): Route {
  switch (command.command) {
    case 'membership':
      return { path: '/membership', schema: TaskBoardMembershipSchema };
    case 'create':
      return { path: '/create', schema: TaskBoardCreateResponseSchema, body: command.body };
    case 'grant-request':
      return { path: '/child-grants/request', schema: TaskBoardGrantRequestViewSchema, body: command.body };
    case 'grant-approve':
      return { path: '/child-grants/approve', schema: TaskBoardGrantRequestViewSchema, body: command.body };
    case 'invite':
      return { path: '/invitations/request', schema: TaskBoardInvitationViewSchema, body: command.body };
    case 'invite-approve':
      return { path: '/invitations/approve', schema: TaskBoardInvitationViewSchema, body: command.body };
    case 'invite-accept':
      return { path: '/invitations/accept', schema: TaskBoardMembershipSchema, body: {} };
    case 'relinquish':
      return { path: '/membership/relinquish', schema: TaskBoardRelinquishResponseSchema, body: {} };
    case 'mark-done':
      return { path: '/mark-done', schema: TaskBoardMembershipSchema, body: command.body };
    case 'coordinator-replace':
      return { path: '/coordinator/replace', schema: TaskBoardMembershipSchema, body: command.body };
    case 'revoke':
      return { path: '/grants/revoke', schema: TaskBoardRevokeResponseSchema, body: command.body };
  }
}

export class FyTaskBoardGateway implements ITaskBoardGateway {
  /** Connects on first request, so a host without a daemon can still print help. */
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async send(command: TaskBoardCommand, headers: Readonly<Record<string, string>>): Promise<unknown> {
    const { path, schema, body } = route(command);
    const init: RequestInit =
      body === undefined
        ? { headers: { ...headers } }
        : { method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json' } };
    return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}${path}`, schema, init);
  }
}
