import type { Command } from 'commander';
import type { LoginEntryController } from './entry-controller.ts';

const collect = (value: string, previous: readonly string[] = []): string[] => [...previous, value];

const ENTRY_HELP = `Saved logins: the owner's password manager, which the input bridge types from. An entry is a label,
what it is for (--match sudo@kirin-box, or a web host like github.com), an optional username (plain text)
and secret fields: a password, and optionally a 2FA seed.

A password or seed is typed at a hidden prompt, sent once and dropped. There is no flag, argument,
environment variable or pipe that carries one, and no command that prints one: an answered input card
types it for you (\`input answer !A7 --secret HANDLE\`) and nothing else ever reads it back.`;

/** Mounts `fy secret entry ls|add|edit|rename|rm` under the `secret` command. */
export function registerLoginEntryCommands(secret: Command, controller: LoginEntryController): void {
  const entry = secret
    .command('entry')
    .description('saved logins the input bridge can type for you')
    .addHelpText('after', `\n${ENTRY_HELP}`);

  entry
    .command('ls', { isDefault: true })
    .description('list the saved logins: label, handle, what they match, username, which fields exist')
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
    .option('--password', 'replace the password (typed at a hidden prompt)')
    .option('--totp', 'keep a 2FA seed (typed at a hidden prompt, after a warning)')
    .option('--no-totp', 'forget the 2FA seed')
    .option('--i-understand-totp', 'skip the typed "yes" after the 2FA warning')
    .action(async (id: string, options: Parameters<LoginEntryController['edit']>[1]) => {
      await controller.edit(id, options);
    });

  entry
    .command('rename <id> <new-id>')
    .description('change a handle; the values follow it')
    .action(async (id: string, to: string) => {
      await controller.rename(id, to);
    });

  entry
    .command('rm <id>')
    .description('delete a saved login')
    .option('-y, --yes', 'do not ask first')
    .action(async (id: string, options: { yes?: boolean }) => {
      await controller.remove(id, options);
    });
}
