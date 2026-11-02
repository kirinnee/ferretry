import { AUTOMATED_CODE_ACK_WORDS, AUTOMATED_CODE_WARNING, TASK_PLAN_HONEST_LIMIT } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { CopyCommandOptions, CopyController, CopyRuleOptions } from './controller.ts';
import type { PlanApproveOptions, PlanCommandOptions, PlanController } from './plan-controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const COPY_HELP = `The owner's command for secure copy. A ferret can seal a value it must not see (a new token) and
paste it by name; each paste asks you on a card unless a paste rule you made here allows it.

  ls --session <id>                 the copies a session holds: where each came from, length, expiry, never a value
  rules ls                          your paste rules (the app's "Pastes approved in advance")
  rules add --from command:gh --to terminal:vercel [--session <id>] [--count N] [--expires 2h]
                                    a paste rule: pastes from what gh prints into the vercel program go unasked;
                                    it is only STAGED here, and you make it with your passkey in the app
  rules rm <id>                     end a paste rule
  rules profile on|off              whether a paste rule may match a program in your own profile (~/.nix-profile);
                                    on is only STAGED here, and you approve it with your passkey in the app
  plan ls | approve | revoke        the same as \`plan\` (see \`plan --help\`)

Every paste a paste rule allows is still raised, audited and shown in the log. A ferret cannot run these commands.
A paste rule is not a standing sign-in rule: see \`fy rules\`.`;

const PLAN_HELP = `The owner's command for a ferret's plan: the sign-ins and pastes it asked you to approve before it starts.

  ls [--session <id>]                           the plans ferrets asked you about, line by line, with their warnings
  approve <id> [1 2 ...] [--pick 2=GITHUB_WORK] [--totp 1 --i-understand-one-factor] [--open]
                                                allow those lines; no numbers declines the plan
  revoke <id> [1 2 ...]                         end those lines (all of them with no numbers)

Every line, a paste line too, is only STAGED here: you confirm the selection with your passkey on the plan's card in
the app, and this command waits for your answer. Nothing is allowed until you do; declining needs no passkey. --totp on a line also lets
Ferretry type its 2FA code: ${AUTOMATED_CODE_WARNING} A ferret cannot run these commands.

${TASK_PLAN_HONEST_LIMIT}`;

const TOTP_HELP = 'also let Ferretry type the 2FA code on this line (needs --i-understand-one-factor)';

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

  const rules = copy.command('rules').description('paste rules: the pastes you approved in advance');
  rules
    .command('ls')
    .description('list the rules')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyCommandOptions) => await controller.rules(options));
  rules
    .command('add')
    .description('make a paste rule: approve a route in advance')
    .requiredOption('--from <source>', 'command:<program>, browser:<origin> or clipboard:<origin>')
    .requiredOption('--to <destination>', 'terminal:<program>, browser:<origin> or secret:<NAME>')
    .option(SESSION_FLAG, 'only this session (default: any)')
    .option('--count <n>', 'how many pastes it allows (default: no count)')
    .option('--expires <time>', 'how long it lasts, like 30m, 2h or 7d (default: no expiry)')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: CopyRuleOptions) => await controller.addRule(options));
  rules
    .command('profile')
    .description('let paste rules match programs in your own profile (on), or only ones the system installed (off)')
    .argument('<state>', 'on: a program from ~/.nix-profile, which any ferret can change, may match; off (the default)')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (state: string, options: CopyCommandOptions) => await controller.profile(state, options));
  rules
    .command('rm')
    .description('end a paste rule')
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
    .option('--totp <line>', TOTP_HELP, collect, [])
    .option('--i-understand-one-factor', AUTOMATED_CODE_ACK_WORDS)
    .option('--open', "open the plan's card in this machine's browser to confirm with your passkey")
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
