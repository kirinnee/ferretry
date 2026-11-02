import type { Command } from 'commander';
import type {
  RulesCommandOptions,
  RulesController,
  RulesNarrowOptions,
  RulesRemoveOptions,
  RulesStageOptions,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';
const EXPIRES_HELP = 'how long it lasts, like 12h or 7d (default: 30 days for a page, 1 day for a terminal)';
const TOTP_HELP = 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)';
const ONE_FACTOR_HELP = 'say you know the password and the code then both come from this machine: one factor';
const OPEN_HELP = "open the rule's page in this machine's browser to confirm with your passkey";

const RULES_HELP = `The owner's command for standing sign-in rules: a sign-in a ferret may use unasked until the rule ends.

  ls                                        your rules, the ones waiting for a passkey, and why any stopped
  add <si_…> [--username] [--scope any|project:<uuid>|session:<id>] [--expires 7d] [--uses N] [--open]
                                            stage a rule; you approve it with your passkey in the app
  resume <sr_…>                             approve a suspended rule again, with a new passkey
  renew <sr_…> [--expires 7d]               approve a rule again for a new period, with a new passkey
  narrow <sr_…> [--drop-totp] [--expires 2h] [--uses N]
                                            take something away; no passkey needed
  rm <sr_…> | --account <ACCOUNT>           end a rule now, or every rule of an account; no passkey needed

add, resume and renew only STAGE the rule: this command prints a link, you confirm with your passkey in the Ferretry
app, and it waits for your answer. Nothing is approved until you do. A rule for sudo, su or doas gives every ferret on
this machine root while it lasts. A ferret cannot run these commands, and a rule guards against tool misuse, not
against a ferret that goes around Ferretry. A paste rule is not one of these: see \`fy copy rules\`.`;

/** Mounts `fy rules ls|add|resume|renew|narrow|rm`. */
export function registerRulesCommands(program: Command, controller: RulesController): void {
  const rules = program
    .command('rules')
    .description('standing sign-in rules: sign-ins a ferret may use unasked, approved with your passkey')
    .addHelpText('after', `\n${RULES_HELP}`);

  rules
    .command('ls')
    .description('list the rules and the ones waiting for a passkey')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (options: RulesCommandOptions) => await controller.list(options));
  rules
    .command('add')
    .description('stage a rule for a sign-in; you approve it with your passkey in the app')
    .argument('<sign-in>', 'the sign-in, as si_… (see `fy accounts`)')
    .option('--username', 'also type the username (default: the password only)')
    .option('--totp', TOTP_HELP)
    .option('--i-understand-one-factor', ONE_FACTOR_HELP)
    .option('--scope <scope>', 'any ferret (default), project:<uuid> or session:<id>')
    .option('--expires <time>', EXPIRES_HELP)
    .option('--uses <n>', 'at most this many fills')
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (signIn: string, options: RulesStageOptions) => await controller.add(signIn, options));
  rules
    .command('resume')
    .description('approve a suspended rule again, with a new passkey')
    .argument('<rule>', 'the rule, by the start of its id')
    .option('--totp', TOTP_HELP)
    .option('--i-understand-one-factor', ONE_FACTOR_HELP)
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesStageOptions) => await controller.resume(rule, options));
  rules
    .command('renew')
    .description('approve a rule again for a new period, with a new passkey')
    .argument('<rule>', 'the rule, by the start of its id')
    .option('--totp', TOTP_HELP)
    .option('--i-understand-one-factor', ONE_FACTOR_HELP)
    .option('--expires <time>', EXPIRES_HELP)
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesStageOptions) => await controller.renew(rule, options));
  rules
    .command('narrow')
    .description('take something away from a rule: the code, time or uses; no passkey')
    .argument('<rule>', 'the rule, by the start of its id')
    .option('--drop-totp', 'stop typing the 2FA code')
    .option('--expires <time>', 'end it this long from now, like 2h')
    .option('--uses <n>', 'lower the cap on fills')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesNarrowOptions) => await controller.narrow(rule, options));
  rules
    .command('rm')
    .description('end a rule now, or every rule of an account; no passkey')
    .argument('[rule]', 'the rule, by the start of its id')
    .option('--account <account>', 'end every standing rule of this account instead')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string | undefined, options: RulesRemoveOptions) => await controller.remove(rule, options));
}
