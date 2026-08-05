import type { Command } from 'commander';
import type { FleetApplyOptions, FleetCommandOptions, FleetController, FleetRecommendOptions } from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the payload instead of the human rendering';

const OVERVIEW = `The fleet is the set of agent accounts this host can run: one home, one wrapper
and one settings layer each, all generated from a single declared configuration.

"apply" is idempotent — run it whenever the configuration changes. Nothing here
talks to the daemon except "recommend", which needs the routing catalog.`;

/** Add the shared flags every fleet verb carries. */
function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/**
 * Mounts `fy fleet …` onto the program.
 *
 * `ls` is the default verb rather than `apply`: a bare group name must never be the one that writes
 * to disk.
 */
export function registerFleetCommands(program: Command, controller: FleetController): void {
  const fleet = scoped(
    program
      .command('fleet')
      .description('provision and inspect the agent accounts this host can run')
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = <T extends FleetCommandOptions>(command: Command): T => ({
    ...(fleet.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    fleet.command('ls', { isDefault: true }).alias('accounts').description('the accounts provisioning last published'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.list(merged(command));
  });

  scoped(
    fleet
      .command('init')
      .description('prepare this host: the fleet directories, a starter configuration, and asset space')
      .addHelpText(
        'after',
        '\nCreates only what is missing, so it is safe to re-run — an upgrade that adds a default\n' +
          'fills it in without touching anything you have edited. It also prints the PATH line the\n' +
          'generated wrappers need, which is the one step nothing else can do for you.',
      ),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.init(merged(command));
  });

  scoped(
    fleet
      .command('apply')
      .description('realize the declared configuration: homes, wrappers, settings and the manifest')
      .option('--dry-run', 'print every write the configuration implies and stop'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.apply(merged<FleetApplyOptions>(command));
  });

  scoped(fleet.command('usage').description("probe every account's remaining quota")).action(
    async (_flags: unknown, command: Command) => {
      await controller.usage(merged(command));
    },
  );

  scoped(
    fleet
      .command('login')
      .description('run each account’s provider login, one at a time')
      .argument('[accountId...]', 'only these accounts, by id; default is every account')
      .addHelpText(
        'after',
        '\nAccounts are logged in one at a time because each is a browser approval a human performs.\n' +
          'An account whose wrapper reads a secret from the environment still gets it; every other\n' +
          'provider variable is stripped, so a login run from inside an agent session cannot\n' +
          'authenticate against that session’s account instead of this one.',
      ),
  ).action(async (accountIds: string[], _flags: unknown, command: Command) => {
    await controller.login(accountIds, merged(command));
  });

  scoped(
    fleet
      .command('recommend')
      .description('which agents suit a piece of work, with the alternatives and what was skipped')
      .argument('<task...>', 'what needs doing')
      .option('--no-usage', 'skip quota probing; the guide then reports quota inputs as missing'),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.recommend(words, merged<FleetRecommendOptions>(command));
  });
}
