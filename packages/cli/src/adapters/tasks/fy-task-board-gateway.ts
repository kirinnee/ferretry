import {
  type IFyApiClient,
  TaskBoardCreateResponseSchema,
  TaskBoardGrantRequestViewSchema,
  TaskBoardInvitationViewSchema,
  TaskBoardMembershipSchema,
  TaskBoardRelinquishResponseSchema,
  TaskBoardRevokeResponseSchema,
} from '@ferretry/protocol';
import type { TaskBoardCommand } from '../../lib/task-boards/board-command';
import type { ITaskBoardGateway } from '../../lib/task-boards/board-controller';

export const TASK_BOARD_ROUTE_PREFIX = '/v1/task-boards';

/**
 * The board surface of the daemon's HTTP API. Every route is a POST except the membership read, and
 * every one of them is answered into a protocol schema rather than trusted as JSON. Each arm dials with
 * its own literal method — `method: 'POST'` on the mutations, `method: 'GET'` on the read — stated
 * directly in the init at the call site, so the verb is a readable fact and not a shared runtime ternary
 * the route-agreement gate had to mark unproven.
 */
export class FyTaskBoardGateway implements ITaskBoardGateway {
  /** Connects on first request, so a host without a daemon can still print help. */
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async send(command: TaskBoardCommand, headers: Readonly<Record<string, string>>): Promise<unknown> {
    switch (command.command) {
      case 'membership':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/membership`, TaskBoardMembershipSchema, {
          method: 'GET',
          headers: { ...headers },
        });
      case 'create':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/create`, TaskBoardCreateResponseSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'grant-request':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/child-grants/request`, TaskBoardGrantRequestViewSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'grant-approve':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/child-grants/approve`, TaskBoardGrantRequestViewSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'invite':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/invitations/request`, TaskBoardInvitationViewSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'invite-approve':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/invitations/approve`, TaskBoardInvitationViewSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'invite-accept':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/invitations/accept`, TaskBoardMembershipSchema, {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'invite-verify':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/invitations/verify`, TaskBoardMembershipSchema, {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'relinquish':
        return this.client.request(
          `${TASK_BOARD_ROUTE_PREFIX}/membership/relinquish`,
          TaskBoardRelinquishResponseSchema,
          {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { ...headers, 'content-type': 'application/json' },
          },
        );
      case 'mark-done':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/mark-done`, TaskBoardMembershipSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'coordinator-replace':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/coordinator/replace`, TaskBoardMembershipSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      case 'revoke':
        return this.client.request(`${TASK_BOARD_ROUTE_PREFIX}/grants/revoke`, TaskBoardRevokeResponseSchema, {
          method: 'POST',
          body: JSON.stringify(command.body),
          headers: { ...headers, 'content-type': 'application/json' },
        });
      default: {
        // A new board command variant must be dialled above; this only exists so the switch is exhaustive.
        const exhaustive: never = command;
        throw new Error(`unhandled board command: ${String(exhaustive)}`);
      }
    }
  }
}
