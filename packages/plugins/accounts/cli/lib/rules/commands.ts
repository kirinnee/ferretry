import {
  AUTOMATED_CODE_ACK_WORDS,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULES_SCREEN_PATH,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import {
  ACCOUNT_LISTING,
  type RulesCommandOptions,
  type RulesController,
  type RulesNarrowOptions,
  type RulesRemoveOptions,
  type RulesStageOptions,
  SIGN_IN_LISTING,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';
const EXPIRES_HELP = 'how long it lasts, like 12h or 7d (default: 30 days for a page, 1 day for a terminal)';
const TOTP_HELP = 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)';
const ONE_FACTOR_HELP = `say "${AUTOMATED_CODE_ACK_WORDS}"`;
const OPEN_HELP = "open the rule's page in this machine's browser to confirm with your passkey";
const USES_HELP = 'at most this many fills (at least 1)';
const RULE_ARGUMENT = 'the rule, by the start of its id';

/** `fy rules` help. The root line and the honest limit are the protocol's own sentences, quoted, never paraphrased. */
export const RULES_HELP = `The owner's command for standing sign-in rules: a sign-in a ferret may use unasked until the rule ends.

  ls                                        your rules, the ones waiting for a passkey, and why any are suspended
  add <si_…> [--username] [--totp --i-understand-one-factor] [--scope any|project:<uuid>|session:<id>]
      [--expires 7d] [--uses N] [--open]    stage a rule; you approve it with your passkey in the app
  resume <sr_…> [--totp --i-understand-one-factor]
                                            approve a suspended rule again, with a new passkey
  renew <sr_…> [--totp --i-understand-one-factor] [--expires 7d] [--uses N]
                                            approve a rule again for a new period, with a new passkey
  widen <sr_…> [--username] [--totp --i-understand-one-factor] [--scope …] [--expires 7d] [--uses N]
                                            give a rule more, with a new passkey; the rest stays as it is
  narrow <sr_…> [--drop-totp] [--expires 2h] [--uses N]
                                            take something away; no passkey needed
  rm <sr_…> | --account <ACCOUNT>           revoke a rule now, or every rule of an account; no passkey needed
                                            (also: revoke)

Find a sign-in's id (si_…) with \`${SIGN_IN_LISTING}\`, an account's with \`${ACCOUNT_LISTING}\`.

add, resume, renew and widen only STAGE the rule: this command prints a link, you confirm with your passkey in the
Ferretry app (${SIGN_IN_RULES_SCREEN_PATH}), and it waits for your answer. Nothing is approved until you do.
A rule for sudo, su or doas: ${SIGN_IN_RULE_ROOT_WARNING}
${SIGN_IN_RULE_HONEST_LIMIT}
A ferret's pane can't run these commands. A paste rule is not one of these: see \`fy copy rules\`.`;

/** `--totp` and its acknowledgement, the same two flags on every verb a passkey approves. */
const withCode = (command: Command): Command =>
  command.option('--totp', TOTP_HELP).option('--i-understand-one-factor', ONE_FACTOR_HELP);

/** Mounts `fy rules ls|add|resume|renew|widen|narrow|rm` (`rm` is also `revoke`). */
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
  withCode(
    rules
      .command('add')
      .description('stage a rule for a sign-in; you approve it with your passkey in the app')
      .argument('<sign-in>', `the sign-in, as si_… (see \`${SIGN_IN_LISTING}\`)`)
      .option('--username', 'also type the username (default: the password only)'),
  )
    .option('--scope <scope>', 'any ferret (default), project:<uuid> or session:<id>')
    .option('--expires <time>', EXPIRES_HELP)
    .option('--uses <n>', USES_HELP)
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (signIn: string, options: RulesStageOptions) => await controller.add(signIn, options));
  withCode(
    rules
      .command('resume')
      .description('approve a suspended rule again, with a new passkey')
      .argument('<rule>', RULE_ARGUMENT),
  )
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesStageOptions) => await controller.resume(rule, options));
  withCode(
    rules
      .command('renew')
      .description('approve a rule again for a new period, with a new passkey')
      .argument('<rule>', RULE_ARGUMENT),
  )
    .option('--expires <time>', EXPIRES_HELP)
    .option('--uses <n>', USES_HELP)
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesStageOptions) => await controller.renew(rule, options));
  withCode(
    rules
      .command('widen')
      .description('give a rule more (the username, the 2FA code, who, time or uses), with a new passkey')
      .argument('<rule>', RULE_ARGUMENT)
      .option('--username', 'also type the username'),
  )
    .option('--scope <scope>', 'who may use it: any, project:<uuid> or session:<id>')
    .option('--expires <time>', 'how long it lasts from now, like 7d (default: it ends when it did)')
    .option('--uses <n>', `${USES_HELP} (default: the uses it has left)`)
    .option('--open', OPEN_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesStageOptions) => await controller.widen(rule, options));
  rules
    .command('narrow')
    .description('take something away from a rule: the 2FA code, time or uses; no passkey')
    .argument('<rule>', RULE_ARGUMENT)
    .option('--drop-totp', 'stop typing the 2FA code')
    .option('--expires <time>', 'end it this long from now, like 2h')
    .option('--uses <n>', 'lower the cap on fills')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string, options: RulesNarrowOptions) => await controller.narrow(rule, options));
  rules
    .command('rm')
    .alias('revoke')
    .description('revoke a rule now, or every rule of an account; no passkey')
    .argument('[rule]', RULE_ARGUMENT)
    .option('--account <account>', 'revoke every standing rule of this account instead')
    .option(JSON_FLAG, JSON_HELP)
    .action(async (rule: string | undefined, options: RulesRemoveOptions) => await controller.remove(rule, options));
}
