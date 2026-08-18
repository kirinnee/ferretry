import type { Command } from 'commander';
import type {
  FleetApplyOptions,
  FleetCommandOptions,
  FleetController,
  FleetInitOptions,
  FleetLoginOptions,
  FleetRecommendOptions,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the payload instead of the human rendering';

const OVERVIEW = `The fleet is the set of agent accounts this host can run: one home, one wrapper
and one settings layer each, all generated from a single declared configuration.

"apply" is idempotent — run it whenever the configuration changes. Almost none of
this leaves the host: only "recommend", which needs the routing catalog, and
"authorize", which approves a change proposed in a browser, talk to the daemon.`;

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
    fleet
      .command('ls', { isDefault: true })
      .alias('accounts')
      .alias('list')
      .description('the accounts provisioning last published'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.list(merged(command));
  });

  scoped(
    fleet
      .command('init')
      .description('prepare this host: the fleet directories, a starter configuration, and asset space')
      .option(
        '--first-account [harness]',
        'declare the first account in a new configuration; without a harness, chooses a launchable CLI (Claude first)',
      )
      .addHelpText(
        'after',
        '\nCreates only what is missing, so it is safe to re-run — an upgrade that adds a default\n' +
          'fills it in without touching anything you have edited. It also prints the PATH line the\n' +
          'generated wrappers need, which is the one step nothing else can do for you.',
      ),
  ).action(async (_flags: unknown, command: Command) => {
    const { firstAccount, ...options } = merged(command) as Omit<FleetInitOptions, 'firstAccount'> & {
      readonly firstAccount?: unknown;
    };
    if (firstAccount !== undefined && firstAccount !== true && firstAccount !== 'claude' && firstAccount !== 'codex') {
      throw new Error('first account must be "claude" or "codex": fy fleet init --first-account=claude');
    }
    await controller.init({
      ...options,
      ...(firstAccount === undefined ? {} : { firstAccount: firstAccount === true ? 'detected' : firstAccount }),
    });
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
  scoped(fleet.command('health').description('explicitly verify each wrapper can complete a sentinel turn')).action(
    async (_flags: unknown, command: Command) => {
      await controller.health(merged(command));
    },
  );

  scoped(
    fleet
      .command('sharing')
      .description('which documents this fleet shares, and which accounts use one rather than their own')
      .addHelpText(
        'after',
        '\nA shared document is one several accounts reference: declare it under "shared:" in the\n' +
          'configuration and it has a name, so this can say who is on it and the Fleet tab can offer it.\n\n' +
          'Per account, each asset is either that shared document, its own copy, or nothing declared —\n' +
          'and this says which slot supplied it, so you know where to edit. A path several accounts\n' +
          'share without being declared is called out: that is a fleet sharing something it never said.\n\n' +
          'It reads the daemon rather than resolving the configuration here, so this terminal and the\n' +
          'browser cannot disagree about whether an account is sharing something.',
      ),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.sharing(merged(command));
  });

  scoped(
    fleet
      .command('login')
      .description('copy each provider login across the accounts that share it, then ask only for what is missing')
      .argument('[accountId...]', 'only the identities these accounts belong to; default is every identity')
      .option('--status', 'report what credential each home holds and change nothing')
      .option('--sync-only', 'copy credentials across identities but never ask for a browser approval')
      .addHelpText(
        'after',
        '\nEvery lane of one provider account keeps its own credential copy, so most of this is copying:\n' +
          'the freshest credential in an identity is cloned onto the siblings that need one, and only an\n' +
          'identity with no usable credential anywhere costs a human an approval. Naming one account\n' +
          'therefore selects its whole identity — the credential is shared, so half an identity is not a\n' +
          'thing you can log in.\n\n' +
          'A home whose credential could not be read is reported, never overwritten and never taken as\n' +
          'empty: that is the difference between "nobody is logged in" and "I could not tell".\n\n' +
          'An account whose wrapper reads a secret from the environment still gets it; every other\n' +
          'provider variable is stripped, so a login run from inside an agent session cannot\n' +
          'authenticate against that session’s account instead of this one.',
      ),
  ).action(async (accountIds: string[], _flags: unknown, command: Command) => {
    await controller.login(accountIds, merged<FleetLoginOptions>(command));
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

  // Deliberately NOT `scoped()`: this verb refuses `--json`, so advertising the flag on it would
  // promise something it declines to do. The group still carries the flag, and the controller
  // answers `fy fleet --json authorize …` by saying why it will not.
  fleet
    .command('authorize')
    .description('approve one change the Fleet tab proposed, by minting the code it is waiting for')
    .argument('<proposalId>', 'the proposal the browser is showing')
    .addHelpText(
      'after',
      '\nA browser paired with this daemon may look at the fleet and may draft a change, seeing exactly\n' +
        'what it would write — but it may not make one. Pairing is not authority over the host, and it\n' +
        'never becomes it. This is where that authority is given, one change at a time.\n\n' +
        'It prints a short-lived, single-use code bound to that one proposal, which the person types\n' +
        'back into the tab. The code approves nothing else, expires by itself, and running this again\n' +
        'replaces it — so the first code stops working.\n\n' +
        'There is no --json. A code a script can read is a code no human approved, and the point of\n' +
        'coming to this terminal is that someone holding this host looked at the change and agreed.',
    )
    .action(async (proposalId: string, _flags: unknown, command: Command) => {
      await controller.authorize(proposalId, merged(command));
    });
}
