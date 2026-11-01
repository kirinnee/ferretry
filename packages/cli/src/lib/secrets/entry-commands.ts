import { LOGIN_METHODS } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { LoginEntryController } from './entry-controller.ts';
import type { TwoFactorSeedController } from './factor-controller.ts';

const collect = (value: string, previous: readonly string[] = []): string[] => [...previous, value];

const ENTRY_HELP = `Accounts: the owner's password manager, which the input bridge types from. An entry is a label,
what it is for (--match sudo@kirin-box, or a web host like github.com), how it signs in (--method:
password, or a provider such as google --via GOOGLE_KIRIN), where the sign-in happens (--domain
accounts.google.com), an optional username (plain text) and secret fields: a password, and optionally a
2FA seed. There is no passkey method: passkeys are off in the agent browser.

A password or seed is typed at a hidden prompt, sent once and dropped. There is no flag, argument,
environment variable or pipe that carries one, and no command that prints one: an answered input card
types it for you (\`input answer !A7 --secret HANDLE\`) and nothing else ever reads it back.`;

const FACTOR_HELP = `A 2FA key Ferretry holds makes that account's codes, so the password and the code then come
from this one machine. So a key is saved only with your PASSKEY, every time, even here at the machine: \`factor add
--totp\` stages it (in memory, two minutes) and puts a card on your agenda; Allow it in the app with your passkey
and it is saved. Nothing else saves one, and nothing ever prints one back. Removing a key never asks.`;

const RECIPE_HELP = `A recipe is the steps to sign in, in Markdown, with no values in it: "Open app.vercel.com, Continue with
Google, [[GOOGLE_KIRIN]], wait for the phone approval". [[ID]] names another account, whose recipe the ferret
is handed too. A ferret that finds the steps wrong proposes a better recipe after it signs in; nothing changes
until you approve it here (or turn on --auto-apply-recipe for that one login).`;

/** Mounts `fy account ls|add|edit|hint|recipe|rename|rm`. */
export function registerAccountCommands(
  program: Command,
  controller: LoginEntryController,
  factors?: TwoFactorSeedController,
): void {
  mountAccountCommands(
    program
      .command('account')
      .description('accounts the input bridge can type for you')
      .addHelpText('after', `\n${ENTRY_HELP}`),
    controller,
    factors,
  );
}

/** `fy account …`: the old spelling of `fy account …`, i.e. `fy secret entry …`, kept for one release and hidden from `fy secret --help`. */
export function registerLoginEntryCommands(
  secret: Command,
  controller: LoginEntryController,
  factors?: TwoFactorSeedController,
): void {
  mountAccountCommands(
    secret
      .command('entry', { hidden: true })
      .description('alias of `fy account`')
      .addHelpText('after', `\n${ENTRY_HELP}`),
    controller,
    factors,
  );
}

function mountAccountCommands(
  entry: Command,
  controller: LoginEntryController,
  factors?: TwoFactorSeedController,
): void {
  entry
    .command('ls', { isDefault: true })
    .description('list the accounts: label, handle, what they match, username, which fields exist')
    .option('--json', 'print the protocol document instead of the human listing')
    .action(async (options: { json?: boolean }) => {
      await controller.list(options);
    });

  entry
    .command('add <id>')
    .description('save a new login; the password is typed at a hidden prompt')
    .requiredOption('--label <text>', 'the name you read it by, e.g. "sudo on kirin-box"')
    .option('--match <target>', 'what it is for: program@host or a web host (repeatable)', collect)
    .option('--username <text>', 'the username (plain text, shown on cards)')
    .option('--method <kind>', `how it signs in: ${LOGIN_METHODS.join(', ')} (default password)`)
    .option('--sso-name <text>', 'with --method sso: the provider as its button says it, e.g. Okta')
    .option('--via <id>', "with a provider method: the provider's account, e.g. GOOGLE_KIRIN")
    .option('--domain <host>', 'where the sign-in happens, e.g. accounts.google.com (repeatable)', collect)
    .option('--no-password', 'save it without a password for now')
    .action(async (id: string, options: Parameters<LoginEntryController['add']>[1]) => {
      await controller.add(id, options);
    });

  entry
    .command('edit <id>')
    .description('change the fields named; the rest are kept')
    .option('--label <text>', 'a new label')
    .option('--match <target>', 'REPLACE what it matches (repeatable)', collect)
    .option('--username <text>', 'a new username')
    .option('--no-username', 'remove the username')
    .option('--method <kind>', `how it signs in: ${LOGIN_METHODS.join(', ')}`)
    .option('--sso-name <text>', 'with --method sso: the provider as its button says it')
    .option('--via <id>', "the provider's account this one signs in via")
    .option('--no-via', 'sign in via no account')
    .option('--domain <host>', 'REPLACE where the sign-in happens (repeatable)', collect)
    .option('--password', 'replace the password (typed at a hidden prompt)')
    .option('--totp', '(moved) a 2FA seed is saved with `account factor add <id> --totp` now')
    .option('--no-totp', 'forget the 2FA seed')
    .option('--i-understand-totp', '(moved, see --totp)')
    .option('--auto-apply-recipe <on|off>', "let a ferret's recipe proposal for this login apply without asking")
    .action(async (id: string, options: Parameters<LoginEntryController['edit']>[1]) => {
      await controller.edit(id, options);
    });

  entry
    .command('hint <site>')
    .description(
      'what a ferret is told about signing in to a site: label, method, login domains, username; never a value',
    )
    .option('--json', 'print the protocol document instead')
    .action(async (site: string, options: { json?: boolean }) => {
      await controller.hint(site, options);
    });

  const recipe = entry
    .command('recipe')
    .description("a login's sign-in steps: show, set, clear, and answer a ferret's proposals")
    .addHelpText('after', `\n${RECIPE_HELP}`);

  recipe
    .command('show <id>', { isDefault: true })
    .description('the recipe, what was seen when it was typed, and each waiting proposal as a change')
    .option('--json', 'print the protocol document instead')
    .action(async (id: string, options: { json?: boolean }) => {
      await controller.recipeShow(id, options);
    });

  recipe
    .command('set <id>')
    .description('replace the recipe with Markdown from a file, or from standard input with --file -')
    .requiredOption('--file <path>', 'the Markdown file, or - for standard input')
    .action(async (id: string, options: { file: string }) => {
      await controller.recipeSet(id, options);
    });

  recipe
    .command('clear <id>')
    .description('remove the recipe')
    .action(async (id: string) => {
      await controller.recipeClear(id);
    });

  recipe
    .command('approve <id> <proposal-id>')
    .description("make a ferret's proposal the recipe")
    .action(async (id: string, proposalId: string) => {
      await controller.recipeDecide(id, proposalId, 'approve');
    });

  recipe
    .command('decline <id> <proposal-id>')
    .description("turn a ferret's proposal down; the recipe stays as it is")
    .action(async (id: string, proposalId: string) => {
      await controller.recipeDecide(id, proposalId, 'decline');
    });

  if (factors !== undefined) {
    const factor = entry
      .command('factor')
      .description("an account's 2FA keys")
      .addHelpText('after', `\n${FACTOR_HELP}`);
    factor
      .command('add <id>')
      .description('save a 2FA key so Ferretry makes the codes; you confirm it with your passkey in the app')
      .option('--totp', 'a TOTP key (typed at a hidden prompt, after a warning): base32, or an otpauth://totp link')
      .option('--label <text>', 'what you call it, e.g. "Authy backup" (default: Authenticator app)')
      .option('-s, --session <id>', 'the agenda board the confirm card goes on (defaults to the current session)')
      .option('--i-understand-totp', 'skip the typed "yes" after the 2FA warning')
      .action(async (id: string, options: Parameters<TwoFactorSeedController['add']>[1]) => {
        await factors.add(id, options);
      });
  }

  entry
    .command('rename <id> <new-id>')
    .description('change a handle; the values follow it')
    .action(async (id: string, to: string) => {
      await controller.rename(id, to);
    });

  entry
    .command('rm <id>')
    .description('delete an account')
    .option('-y, --yes', 'do not ask first')
    .action(async (id: string, options: { yes?: boolean }) => {
      await controller.remove(id, options);
    });
}
