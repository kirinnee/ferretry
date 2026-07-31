import { refuse } from '../tasks/errors';
import type { TaskBoardCommand } from './board-command';

/**
 * Which secret proves the caller may run a command.
 *
 * - `peer` — the calling session's own board binding. The target of an operation never selects it,
 *   so a spoofed `--session`, body or header cannot reach another member's secret.
 * - `admin` — the human operator's capability. Deliberately unavailable inside a teammate pane.
 * - `invitation` — the invitee's pre-membership proof plus the one-time invitation proof. Distinct
 *   from a binding because it must say *which live session* accepted, before that session has one.
 */
export type TaskBoardCredentialKind = 'peer' | 'admin' | 'invitation';

const ADMIN_COMMANDS = new Set<TaskBoardCommand['command']>(['create', 'mark-done', 'coordinator-replace', 'revoke']);

export function taskBoardCredentialKind(command: TaskBoardCommand): TaskBoardCredentialKind {
  if (command.command === 'invite-accept') return 'invitation';
  return ADMIN_COMMANDS.has(command.command) ? 'admin' : 'peer';
}

/** The capabilities the environment carried in. Absent means the daemon issued none to this caller. */
export interface TaskBoardCredentials {
  readonly peer?: string | undefined;
  readonly admin?: string | undefined;
  readonly session?: string | undefined;
  readonly invitation?: string | undefined;
}

/** Header names the daemon reads the proofs from. Never a body field, never argv. */
export const FY_BOARD_CAPABILITY_HEADER = 'x-fy-board-capability';
export const FY_BOARD_ADMIN_CAPABILITY_HEADER = 'x-fy-board-admin-capability';
export const FY_SESSION_BOARD_CAPABILITY_HEADER = 'x-fy-session-board-capability';
export const FY_BOARD_INVITATION_CAPABILITY_HEADER = 'x-fy-board-invitation-capability';

const proof = (value: string | undefined, missing: string): string => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? refuse(missing) : trimmed;
};

/**
 * The headers a command must carry. A missing capability is refused here, before the request is
 * built, so no board command is ever sent unauthenticated and then rejected by the daemon.
 */
export function taskBoardHeaders(
  command: TaskBoardCommand,
  credentials: TaskBoardCredentials,
): Readonly<Record<string, string>> {
  switch (taskBoardCredentialKind(command)) {
    case 'admin':
      return {
        [FY_BOARD_ADMIN_CAPABILITY_HEADER]: proof(
          credentials.admin,
          'this is an operator command: it needs FY_BOARD_ADMIN_CAPABILITY, which is never issued to a teammate',
        ),
      };
    case 'invitation':
      return {
        [FY_SESSION_BOARD_CAPABILITY_HEADER]: proof(
          credentials.session,
          'accepting an invitation needs FY_SESSION_BOARD_CAPABILITY, delivered by the daemon to this session',
        ),
        [FY_BOARD_INVITATION_CAPABILITY_HEADER]: proof(
          credentials.invitation,
          'accepting an invitation needs FY_BOARD_INVITATION_CAPABILITY, delivered by the daemon once the coordinator approves',
        ),
      };
    case 'peer':
      return {
        [FY_BOARD_CAPABILITY_HEADER]: proof(
          credentials.peer,
          'this session has no board membership: FY_BOARD_CAPABILITY is unset',
        ),
      };
  }
}
