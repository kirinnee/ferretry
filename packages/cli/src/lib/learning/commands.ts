import type { Command } from 'commander';
import type {
  LearningCommandOptions,
  LearningController,
  LearningListOptions,
  LearningRejectOptions,
  LearningRunOptions,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const OVERVIEW = `Learning mines finished sessions for the corrections a human made and turns the
recurring ones into proposed guidance. Nothing is ever applied automatically:
a proposal you accept is rendered by "patch" for you to paste into your own
guidance file.`;

/** Add the shared flags every learning verb carries. */
function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/**
 * Mounts `fy learning …` onto the program.
 *
 * `ls` is the default verb: the board is what a human opens this group to read, and the pending
 * proposals are the only thing on it that asks anything of them.
 */
export function registerLearningCommands(program: Command, controller: LearningController): void {
  const learning = scoped(
    program
      .command('learning')
      .description('judge the guidance the daemon proposes from your own corrections')
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = <T extends LearningCommandOptions>(command: Command): T => ({
    ...(learning.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    learning
      .command('ls', { isDefault: true })
      .alias('list')
      .description('list proposals, pending first-and-only unless widened')
      .option('--state <state>', 'narrow to pending, accepted or rejected')
      .option('--all', 'every state, not just the pending ones'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.list(merged<LearningListOptions>(command));
  });

  scoped(
    learning
      .command('show')
      .description('show one proposal in full, with every quote behind it')
      .argument('<id>', 'the proposal id'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.show(id, merged(command));
  });

  scoped(
    learning.command('accept').description('accept a proposal as guidance').argument('<id>', 'the proposal id'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.accept(id, merged(command));
  });

  scoped(
    learning
      .command('reject')
      .description('reject a proposal; the daemon will not propose it again')
      .argument('<id>', 'the proposal id')
      .option('-n, --note <text>', 'why it was rejected, recorded in the audit'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.reject(id, merged<LearningRejectOptions>(command));
  });

  scoped(
    learning
      .command('edit')
      .description('reword a proposal before accepting it')
      .argument('<id>', 'the proposal id')
      .argument('<rule...>', 'the replacement rule text'),
  ).action(async (id: string, rule: string[], _flags: unknown, command: Command) => {
    await controller.edit(id, rule, merged(command));
  });

  scoped(
    learning
      .command('patch')
      .description('print the guidance file an accepted proposal edits, for you to apply')
      .argument('<id>', 'the proposal id'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.patch(id, merged(command));
  });

  scoped(
    learning
      .command('run')
      .description('mine now instead of waiting for the schedule')
      .option('--spawn', 'also launch the miner sessions this run needs'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.run(merged<LearningRunOptions>(command));
  });

  scoped(learning.command('status').description('whether mining is on, what is pending, how the last run went')).action(
    async (_flags: unknown, command: Command) => {
      await controller.status(merged(command));
    },
  );

  scoped(learning.command('config').description('the mining schedule and the agent that performs it')).action(
    async (_flags: unknown, command: Command) => {
      await controller.config(merged(command));
    },
  );
}
