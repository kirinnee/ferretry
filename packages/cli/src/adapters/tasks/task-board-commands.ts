import { TaskBoardChildAccessSchema } from '@ferretry/protocol';
import type { Command } from 'commander';
import {
  coordinatorReplaceCommand,
  createBoardCommand,
  grantApproveCommand,
  grantRequestCommand,
  inviteAcceptCommand,
  inviteApproveCommand,
  inviteCommand,
  inviteVerifyCommand,
  markDoneCommand,
  membershipCommand,
  relinquishCommand,
  revokeCommand,
} from '../../lib/task-boards/board-command';
import { type ITaskBoardGateway, TaskBoardController } from '../../lib/task-boards/board-controller';
import type { TaskBoardCredentials } from '../../lib/task-boards/board-credentials';
import type { ITaskOutput } from '../../lib/tasks/ports';

export interface TaskBoardCommandDependencies {
  readonly gateway: ITaskBoardGateway;
  readonly io: ITaskOutput;
  readonly credentials: TaskBoardCredentials;
}

export function registerTaskBoardCommands(program: Command, dependencies: TaskBoardCommandDependencies): Command {
  const controller = new TaskBoardController(dependencies.gateway, dependencies.io, dependencies.credentials);

  const group = program
    .command('task-board')
    .description('board membership, grants and invitations')
    // No command accepts or prints a board id: a caller authenticates as itself, never as a board.
    .addHelpText('after', '\nNo command accepts or prints a board id; capabilities arrive out of band.');

  group
    .command('membership')
    .description("this session's own membership and what it may do")
    .action(async () => {
      await controller.run(membershipCommand());
    });

  group
    .command('create')
    .description('open a board for a creator and its coordinator')
    .requiredOption('--creator <session>', 'the session the work belongs to')
    .requiredOption('--coordinator <session>', 'the session that coordinates it')
    .option('--mark-done', 'let the creator mark work done')
    .action(async (options: { creator?: string; coordinator?: string; markDone?: boolean }) => {
      await controller.run(createBoardCommand(options));
    });

  group
    .command('grant-request')
    .description('ask the coordinator to admit a child session')
    .argument('<child>', 'the child session')
    .requiredOption('--role <role>', `one of ${TaskBoardChildAccessSchema.options.join(' | ')}`)
    .action(async (child: string, options: { role?: string }) => {
      await controller.run(grantRequestCommand(child, options));
    });

  group
    .command('grant-approve')
    .description('approve a pending child grant')
    .argument('<request-id>', 'the grant request id')
    .action(async (requestId: string) => {
      await controller.run(grantApproveCommand(requestId));
    });

  group
    .command('invite')
    .description('ask to admit an external top-level session')
    .argument('<session>', 'the external session')
    .action(async (session: string) => {
      await controller.run(inviteCommand(session));
    });

  group
    .command('invite-approve')
    .description('approve a pending invitation')
    .argument('<request-id>', 'the invitation request id')
    .action(async (requestId: string) => {
      await controller.run(inviteApproveCommand(requestId));
    });

  group
    .command('invite-accept')
    .description('accept an approved invitation; the daemon delivers the proof out of band')
    .action(async () => {
      await controller.run(inviteAcceptCommand());
    });

  group
    .command('invite-verify')
    .description('prove an accepted external invitation can act before its predecessor leaves')
    .action(async () => {
      await controller.run(inviteVerifyCommand());
    });

  group
    .command('relinquish')
    .description('give up this session’s membership')
    .action(async () => {
      await controller.run(relinquishCommand());
    });

  group
    .command('mark-done')
    .description('allow or forbid a top-level session marking work done')
    .argument('<session>', 'the top-level session')
    .option('--enable', 'allow it')
    .option('--disable', 'forbid it')
    .action(async (session: string, options: { enable?: boolean; disable?: boolean }) => {
      await controller.run(markDoneCommand(session, options));
    });

  group
    .command('coordinator-replace')
    .description('replace a board member with another session')
    .argument('<member>', 'the current board member')
    .argument('<replacement>', 'the replacement session')
    .argument('<replacement-root>', 'the live membership root whose tree contains the replacement')
    .action(async (member: string, replacement: string, replacementRoot: string) => {
      await controller.run(coordinatorReplaceCommand(member, replacement, replacementRoot));
    });

  group
    .command('revoke')
    .description('revoke a grant, recording why')
    .argument('<member>', 'the current board member')
    .argument('<target>', 'the session losing access')
    .requiredOption('--reason <why>', 'why it was revoked')
    .action(async (member: string, target: string, options: { reason?: string }) => {
      await controller.run(revokeCommand(member, target, options));
    });

  return group;
}
