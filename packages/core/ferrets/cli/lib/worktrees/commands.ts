import type { Command } from 'commander';
import type {
  WorktreeCommandOptions,
  WorktreeController,
  WorktreeForkOptions,
  WorktreeRemoveOptions,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const OVERVIEW = `A managed worktree is a checkout the daemon created for a session. Removing one
is irreversible, so there is no blanket --force: each class of loss has its own
flag, and "check" tells you exactly which ones a removal would need.

  --discard-changes   throw away uncommitted work in the worktree
  --accept-unpushed   remove commits that exist nowhere else
  --delete-unmerged   delete a branch that was never merged`;

/** Add the shared flags every worktree verb carries. */
function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/**
 * Mounts `fy worktree …` onto the program.
 *
 * `ls` is the default verb: the group exists to answer "what checkouts is the daemon holding", and
 * that is the question a bare `fy worktree` is asking.
 */
export function registerWorktreeCommands(program: Command, controller: WorktreeController): void {
  const worktree = scoped(
    program
      .command('worktree')
      .alias('worktrees')
      .description('inspect and remove the checkouts the daemon created for sessions')
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = <T extends WorktreeCommandOptions>(command: Command): T => ({
    ...(worktree.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    worktree.command('ls', { isDefault: true }).alias('list').description('every managed worktree, live ones first'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.list(merged(command));
  });

  scoped(
    worktree
      .command('check')
      .description('say whether a worktree can be removed, and what stands in the way')
      .argument('<path>', 'the worktree path'),
  ).action(async (path: string, _flags: unknown, command: Command) => {
    await controller.check(path, merged(command));
  });

  scoped(
    worktree
      .command('rm')
      .alias('remove')
      .description('remove a worktree once every blocker is accounted for')
      .argument('<path>', 'the worktree path')
      .option('--discard-changes', 'accept losing uncommitted work in the worktree')
      .option('--accept-unpushed', 'accept losing commits that exist nowhere else')
      .option('--delete-unmerged', 'accept deleting a branch that was never merged')
      .option('--delete-branch', 'delete the branch too instead of leaving it behind')
      .option('--delete-preexisting', 'allow deleting a branch that existed before the worktree')
      .option('-y, --yes', 'skip the typed confirmation; required when not on a terminal'),
  ).action(async (path: string, _flags: unknown, command: Command) => {
    await controller.remove(path, merged<WorktreeRemoveOptions>(command));
  });

  scoped(
    worktree
      .command('fork')
      .alias('add')
      .description('fork a new checkout for a branch, and say where to start work in it')
      .argument('<branch>', 'the branch to check out; created when it does not exist yet')
      .option('--base <ref>', 'start a new branch at this commit-ish')
      .option('--from-default', "start a new branch at the repository's default branch")
      .option('--from-head', "start a new branch at the source checkout's current commit")
      .option('--from <path>', 'the checkout to fork from; the current directory otherwise')
      .option('--session <id>', 'the session that will own the new checkout'),
  ).action(async (branch: string, _flags: unknown, command: Command) => {
    await controller.fork(branch, merged<WorktreeForkOptions>(command));
  });
}
