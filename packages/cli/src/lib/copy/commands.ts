import type { Command } from 'commander';
import type { CopyCommandOptions, CopyController, CopyRuleOptions } from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const COPY_HELP = `The owner's command for secure copy. A ferret can seal a value it must not see (a new token) and
paste it by name; each paste asks you on a card unless you approved that route in advance here.

  ls --session <id>                 the copies a session holds: where each came from, length, expiry, never a value
  rules ls                          the routes you approved in advance
  rules add --from command:gh --to terminal:vercel [--session <id>] [--count N] [--expires 2h]
                                    approve pastes from what gh prints into the vercel program, in advance
  rules rm <id>                     take a rule back
  plan ls [--session <id>]          the paste plans ferrets asked you about
  plan approve <id> [1 2 ...]       allow those items, each once; no numbers declines the plan

Every paste a rule allows is still raised, audited and shown in the log. A ferret cannot run these commands.`;

/** Mounts `fy copy ls|rules|plan`. */
export function registerCopyCommands(program: Command, controller: CopyController): void {
  const copy = program
    .command('copy')
    .description("see a ferret's secure copies and approve its pastes in advance")
    .addHelpText('after', `\n${COPY_HELP}`);

  copy
    .command('ls')
    .description('list the secure copies a session holds')
    .option(SESSION_FLAG, 'the session')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyCommandOptions) => await controller.list(options));

  const rules = copy.command('rules').description('the pastes you approved in advance');
  rules
    .command('ls')
    .description('list the rules')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyCommandOptions) => await controller.rules(options));
  rules
    .command('add')
    .description('approve a route in advance')
    .requiredOption('--from <source>', 'command:<program>, browser:<origin> or clipboard:<origin>')
    .requiredOption('--to <destination>', 'terminal:<program>, browser:<origin> or secret:<NAME>')
    .option(SESSION_FLAG, 'only this session (default: any)')
    .option('--count <n>', 'how many pastes it allows (default: no count)')
    .option('--expires <time>', 'how long it lasts, like 30m, 2h or 7d (default: no expiry)')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyRuleOptions) => await controller.addRule(options));
  rules
    .command('rm')
    .description('take a rule back')
    .argument('<id>', 'the rule, by the start of its id')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (id: string, options: CopyCommandOptions) => await controller.removeRule(id, options));

  const plan = copy.command('plan').description("a ferret's plan of pastes, asked before it starts");
  plan
    .command('ls')
    .description('list the plans waiting for you')
    .option(SESSION_FLAG, 'only this session')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyCommandOptions) => await controller.plans(options));
  plan
    .command('approve')
    .description('allow the numbered items of a plan; no numbers declines it')
    .argument('<id>', 'the plan, by the start of its id')
    .argument('[items...]', 'the item numbers to allow, as listed')
    .option(JSON_FLAG, JSON_HELP)
    .action(
      async (id: string, items: string[], options: CopyCommandOptions) => await controller.approve(id, items, options),
    );
}
