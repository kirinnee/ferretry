import type { Command } from 'commander';
import type { CopyCommandOptions, CopyController, CopyRuleOptions } from './controller.ts';
import type { PlanApproveOptions, PlanCommandOptions, PlanController } from './plan-controller.ts';

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
  plan ls | approve | revoke        the same as \`plan\` (see \`plan --help\`)

Every paste a rule allows is still raised, audited and shown in the log. A ferret cannot run these commands.`;

const PLAN_HELP = `The owner's command for a ferret's plan: the sign-ins and pastes it asked you to approve before it starts.

  ls [--session <id>]                           the plans ferrets asked you about, line by line
  approve <id> [1 2 ...] [--pick 2=GITHUB_WORK] [--totp 1]
                                                allow those lines; no numbers declines the plan
  revoke <id> [1 2 ...]                         end those lines (all of them with no numbers)

A paste line is allowed at once. A sign-in line is only STAGED here: you confirm it with your passkey on the plan's
card in the app, and this command waits for your answer. Nothing signs in until you do. A ferret cannot run these
commands, and a plan guards against tool misuse, not against a ferret that goes around Ferretry.`;

/** Mounts `fy copy ls|rules`, `fy plan` and its alias `fy copy plan`, both on the one plan controller. */
export function registerCopyCommands(program: Command, controller: CopyController, plans: PlanController): void {
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

  mountPlanCommands(
    copy.command('plan').description("the same as 'plan': a ferret's plan, asked before it starts"),
    plans,
  );
  mountPlanCommands(
    program
      .command('plan')
      .description("a ferret's plan of sign-ins and pastes, asked before it starts")
      .addHelpText('after', `\n${PLAN_HELP}`),
    plans,
  );
}

const collect = (value: string, previous: readonly string[]): string[] => [...previous, value];

function mountPlanCommands(plan: Command, controller: PlanController): void {
  plan
    .command('ls')
    .description('list the plans, line by line')
    .option(SESSION_FLAG, 'only this session')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: PlanCommandOptions) => await controller.list(options));
  plan
    .command('approve')
    .description('allow the numbered lines of a plan; no numbers declines it')
    .argument('<id>', 'the plan, by the start of its id')
    .argument('[lines...]', 'the line numbers to allow, as listed')
    .option('--pick <line=account>', 'which account signs in on a line with several (a handle or si_…)', collect, [])
    .option('--totp <line>', 'also let Ferretry type the 2FA code on this line', collect, [])
    .option(JSON_FLAG, JSON_HELP)
    .action(
      async (id: string, lines: string[], options: PlanApproveOptions) => await controller.approve(id, lines, options),
    );
  plan
    .command('revoke')
    .description('end the numbered lines of a plan (all when none is named)')
    .argument('<id>', 'the plan, by the start of its id')
    .argument('[lines...]', 'the line numbers to end')
    .option(JSON_FLAG, JSON_HELP)
    .action(
      async (id: string, lines: string[], options: PlanCommandOptions) => await controller.revoke(id, lines, options),
    );
}
