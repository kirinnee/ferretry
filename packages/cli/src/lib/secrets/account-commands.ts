import { LOGIN_METHODS, PUSH_APPS } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { AccountController } from './account-controller.ts';
import type { FactorKeyController } from './factor-keys-controller.ts';
import type { TwoFactorSeedController } from './factor-controller.ts';
import type { SignInController } from './sign-in-controller.ts';

/** The controllers `fy account` drives. The seed controller is optional: only a build that can stage a seed has it. */
export interface AccountControllers {
  readonly accounts: AccountController;
  readonly signIns: SignInController;
  readonly factorKeys: FactorKeyController;
  readonly seeds?: TwoFactorSeedController | undefined;
}

const collect = (value: string, previous: readonly string[] = []): string[] => [...previous, value];

const ACCOUNT_HELP = `Accounts: the owner's password manager, which the input bridge types from. An ACCOUNT is a label,
an optional username (plain text) and secret fields (a password, 2FA keys). It signs in at one or more
PLACES, each a SIGN-IN (\`account site\`): a site (--domain where it signs in, --for what it is for) or a
terminal (--tool, --host, --dest), and how it signs in there (--method: password, or a provider such as
google --via GOOGLE_KIRIN). There is no passkey method: passkeys are off in the agent browser.

A password or seed is typed at a hidden prompt, sent once and dropped. There is no flag, argument,
environment variable or pipe that carries one, and no command that prints one.

Changing any of this is the OWNER's. The daemon refuses a ferret's call to every write here, and this command says
so and does not try another credential.`;

const SITE_HELP = `A sign-in is named by its id (si_…), which \`account ls\` and \`account site ls\` print. An account
can sign in at several places, and one place can offer several accounts (\`account hint <site>\` says which a ferret
is told about).`;

const FACTOR_HELP = `A 2FA key Ferretry holds makes that account's codes, so the password and the code then come
from this one machine. So a seed is saved only with your PASSKEY, every time, even here at the machine: \`factor add
--totp\` stages it (in memory, two minutes) and puts a card on your agenda; Allow it in the app with your passkey
and it is saved. Nothing else saves one, and nothing ever prints one back. The other kinds hold no value: they only
tell a ferret how this account asks for a code. Removing a key asks first.`;

const RECIPE_HELP = `A recipe is the steps to sign in, in Markdown, with no values in it: "Open app.vercel.com, Continue with
Google, [[GOOGLE_KIRIN]], wait for the phone approval". [[ID]] names another account, whose recipe the ferret
is handed too. A ferret that finds the steps wrong proposes a better recipe after it signs in; nothing changes
until you approve it here (or turn on --auto-apply-recipe for that one sign-in).`;

const DEFAULT_HELP = `A default says which account to use when more than one fits: for one site, or for a board project, or
for a folder. It is a statement of yours, written for the whole machine to \`account-defaults.yaml\` by the daemon.
KEY is the site host for a site default, or the project or folder name with --project / --folder.`;

/** Mounts `fy account …`. */
export function registerAccountCommands(program: Command, controllers: AccountControllers): void {
  mountAccountCommands(
    program
      .command('account')
      .description('accounts, where they sign in, and their 2FA keys')
      .addHelpText('after', `\n${ACCOUNT_HELP}`),
    controllers,
  );
}

/** `fy secret entry …`: the old spelling of `fy account …`, hidden from `fy secret --help`. */
export function registerLoginEntryCommands(secret: Command, controllers: AccountControllers): void {
  mountAccountCommands(
    secret
      .command('entry', { hidden: true })
      .description('alias of `fy account`')
      .addHelpText('after', `\n${ACCOUNT_HELP}`),
    controllers,
  );
}

function placeOptions(command: Command, replace: boolean): Command {
  const verb = replace ? 'REPLACE ' : '';
  return command
    .option('--domain <host>', `${verb}where the sign-in happens, e.g. accounts.google.com (repeatable)`, collect)
    .option('--for <host>', `${verb}what it is for, e.g. app.vercel.com (repeatable)`, collect)
    .option('--tool <program>', `terminal: ${verb}the program asking, e.g. sudo, ssh`)
    .option('--host <machine>', `terminal: ${verb}the machine it runs on`)
    .option('--dest <machine>', `terminal: ${verb}where ssh, scp or sftp go`);
}

function methodOptions(command: Command, withNo: boolean): Command {
  command
    .option('--method <kind>', `how it signs in: ${LOGIN_METHODS.join(', ')}`)
    .option('--sso-name <text>', 'with --method sso: the provider as its button says it, e.g. Okta')
    .option('--via <id>', "with a provider method: the provider's account, e.g. GOOGLE_KIRIN");
  return withNo ? command.option('--no-via', 'sign in via no account') : command;
}

function mountAccountCommands(account: Command, controllers: AccountControllers): void {
  const { accounts, signIns, factorKeys, seeds } = controllers;

  account
    .command('ls', { isDefault: true })
    .description('list the accounts, with their 2FA keys and sign-ins')
    .option('--json', 'print the protocol document instead of the human listing')
    .action(async (options: { json?: boolean }) => {
      await accounts.list(options);
    });

  methodOptions(
    placeOptions(
      account
        .command('add <id>')
        .description('save a new account; the password is typed at a hidden prompt')
        .requiredOption('--label <text>', 'the name you read it by, e.g. "sudo on kirin-box"')
        .option('--username <text>', 'the username (plain text, shown on cards)')
        .option('--no-password', 'save it without a password for now'),
      false,
    ),
    false,
  )
    .addHelpText(
      'after',
      '\nWith a place or method flag, the first sign-in is added too; otherwise use `account site add`.',
    )
    .action(async (id: string, options: Parameters<AccountController['add']>[1]) => {
      await accounts.add(id, options);
    });

  account
    .command('edit <id>')
    .description('change the fields named; the rest are kept')
    .option('--label <text>', 'a new label')
    .option('--username <text>', 'a new username')
    .option('--no-username', 'remove the username')
    .option('--password', 'replace the password (typed at a hidden prompt)')
    .option('--totp', '(moved) a 2FA seed is saved with `account factor add <id> --totp`')
    .action(async (id: string, options: Parameters<AccountController['edit']>[1]) => {
      await accounts.edit(id, options);
    });

  account
    .command('rename <id> <new-id>')
    .description('change a handle; the values follow it')
    .action(async (id: string, to: string) => {
      await accounts.rename(id, to);
    });

  account
    .command('rm <id>')
    .description('delete an account with its sign-ins and 2FA keys')
    .option('-y, --yes', 'do not ask first')
    .action(async (id: string, options: { yes?: boolean }) => {
      await accounts.remove(id, options);
    });

  account
    .command('merge <keep> <from>')
    .description('fold the account FROM into KEEP: its sign-ins and 2FA keys move, then it is gone')
    .option('-y, --yes', 'do not ask first')
    .action(async (keep: string, from: string, options: { yes?: boolean }) => {
      await accounts.merge(keep, from, options);
    });

  account
    .command('apart <id> <other>')
    .description('say two accounts are different, so look-alike and merge hints stop pairing them')
    .action(async (id: string, other: string) => {
      await accounts.apart(id, other);
    });

  account
    .command('look-alike')
    .description('groups of accounts with the same username and password (handles only), which may be one account')
    .option('--json', 'print the protocol document instead')
    .action(async (options: { json?: boolean }) => {
      await accounts.lookAlike(options);
    });

  account
    .command('hint <site>')
    .description('what a ferret is told about signing in to a site: label, method, domains, username; never a value')
    .option('--json', 'print the protocol document instead')
    .action(async (site: string, options: { json?: boolean }) => {
      await accounts.hint(site, options);
    });

  const defaults = account
    .command('default')
    .description('which account to use when more than one fits')
    .addHelpText('after', `\n${DEFAULT_HELP}`);

  defaults
    .command('set <key> <account>')
    .description('use ACCOUNT for KEY: a site host, or --project / --folder')
    .option('--project <name>', 'KEY is a board project')
    .option('--folder <path>', 'KEY is a folder')
    .action(async (key: string, id: string, options: { project?: string; folder?: string }) => {
      await accounts.defaultSet(key, id, options);
    });

  defaults
    .command('rm <key>')
    .description('stop using a default for KEY')
    .option('--project <name>', 'KEY is a board project')
    .option('--folder <path>', 'KEY is a folder')
    .action(async (key: string, options: { project?: string; folder?: string }) => {
      await accounts.defaultRemove(key, options);
    });

  const site = account
    .command('site')
    .description("an account's sign-ins: the places it signs in, and how")
    .addHelpText('after', `\n${SITE_HELP}`);

  site
    .command('ls [account]', { isDefault: true })
    .description('list the sign-ins (one account, or all), each with its si_ id')
    .option('--json', 'print the sign-ins as JSON instead')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      await signIns.list(id, options);
    });

  methodOptions(
    placeOptions(site.command('add <account>').description('add a place this account signs in'), false),
    false,
  )
    .option('--auto-apply-recipe <on|off>', "let a ferret's recipe proposal for this sign-in apply without asking")
    .action(async (id: string, options: Parameters<SignInController['add']>[1]) => {
      await signIns.add(id, options);
    });

  methodOptions(
    placeOptions(site.command('edit <sign-in>').description('change the parts named; the rest are kept'), true),
    true,
  )
    .option('--auto-apply-recipe <on|off>', "let a ferret's recipe proposal for this sign-in apply without asking")
    .action(async (id: string, options: Parameters<SignInController['edit']>[1]) => {
      await signIns.edit(id, options);
    });

  site
    .command('rm <sign-in>')
    .description('remove a sign-in; the account stays')
    .option('-y, --yes', 'do not ask first')
    .action(async (id: string, options: { yes?: boolean }) => {
      await signIns.remove(id, options);
    });

  const recipe = site
    .command('recipe')
    .description("a sign-in's steps: show, set, clear, and answer a ferret's proposals")
    .addHelpText('after', `\n${RECIPE_HELP}`);

  recipe
    .command('show <sign-in>', { isDefault: true })
    .description('the recipe, what was seen when it was typed, and each waiting proposal as a change')
    .option('--json', 'print the sign-in as JSON instead')
    .action(async (id: string, options: { json?: boolean }) => {
      await signIns.recipeShow(id, options);
    });

  recipe
    .command('set <sign-in>')
    .description('replace the recipe with Markdown from a file, or from standard input with --file -')
    .requiredOption('--file <path>', 'the Markdown file, or - for standard input')
    .action(async (id: string, options: { file: string }) => {
      await signIns.recipeSet(id, options);
    });

  recipe
    .command('clear <sign-in>')
    .description('remove the recipe')
    .action(async (id: string) => {
      await signIns.recipeClear(id);
    });

  recipe
    .command('approve <sign-in> <proposal-id>')
    .description("make a ferret's proposal the recipe")
    .action(async (id: string, proposalId: string) => {
      await signIns.recipeDecide(id, proposalId, 'approve');
    });

  recipe
    .command('decline <sign-in> <proposal-id>')
    .description("turn a ferret's proposal down; the recipe stays as it is")
    .action(async (id: string, proposalId: string) => {
      await signIns.recipeDecide(id, proposalId, 'decline');
    });

  const factor = account
    .command('factor')
    .description("an account's 2FA keys")
    .addHelpText('after', `\n${FACTOR_HELP}`);

  factor
    .command('ls [account]', { isDefault: true })
    .description('list the 2FA keys (one account, or all), each with its tf_ id')
    .option('--json', 'print the keys as JSON instead')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      await factorKeys.list(id, options);
    });

  factor
    .command('add <account>')
    .description('add a 2FA key: --totp saves a seed (confirmed with your passkey), the others hold no value')
    .option('--totp', 'a TOTP key Ferretry makes codes from (typed at a hidden prompt, then confirmed in the app)')
    .option('--authenticator', 'a TOTP app only you hold: Ferretry stores no seed, you type its codes')
    .option('--sms', 'a code by text message')
    .option('--ends-with <digits>', 'with --sms: the last 2 to 4 digits of the number')
    .option('--email', 'a code by email')
    .option('--to <address>', 'with --email: where it arrives, as it is shown')
    .option('--push', 'an approval on your phone')
    .option('--app <name>', `with --push: ${PUSH_APPS.join(', ')}`)
    .option('--security-key', 'a hardware key you tap')
    .option('--label <text>', 'what you call it, e.g. "Authy backup" (required, except with --totp)')
    .option(
      '-s, --session <id>',
      'with --totp: the agenda board the confirm card goes on (defaults to the current session)',
    )
    .option('--i-understand-totp', 'with --totp: skip the typed "yes" after the 2FA warning')
    .action(
      async (
        id: string,
        options: Parameters<FactorKeyController['add']>[1] & Parameters<TwoFactorSeedController['add']>[1],
      ) => {
        if (options.totp === true) {
          if (seeds === undefined) throw new Error('this build cannot stage a 2FA seed');
          const others = [options.authenticator, options.sms, options.email, options.push, options.securityKey];
          if (others.some(flag => flag === true))
            throw new Error('--totp is a kind of its own: do not combine it with another kind');
          await seeds.add(id, options);
          return;
        }
        await factorKeys.add(id, options);
      },
    );

  factor
    .command('rm <account> <factor>')
    .description('remove a 2FA key; for one whose seed Ferretry holds, the seed goes with it')
    .option('-y, --yes', 'do not ask first')
    .action(async (id: string, key: string, options: { yes?: boolean }) => {
      await factorKeys.remove(id, key, options);
    });
}
