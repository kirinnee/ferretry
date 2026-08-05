import type { Command } from 'commander';
import type { SecretController, SecretListOptions, SecretUseOptions } from './controller.ts';

const JSON_FLAG = '--json';

/**
 * Mounts `fy secret …`.
 *
 * `set` takes NO value argument. That is deliberate and it is the whole point of the command: a
 * credential typed on a command line is in the shell history of whoever typed it and readable in
 * `/proc/<pid>/cmdline` by every account on the box while it runs. The value comes in on stdin.
 *
 * `use` is the verb agents are meant to reach for:
 *
 *     fy secret use --with ANTHROPIC_KEY -- curl -H "Authorization: Bearer $ANTHROPIC_KEY" https://…
 *
 * The caller writes the NAME. Ferretry puts the value in the environment of the child it spawns and
 * relays that child's output with every known value masked. The calling agent never holds the
 * credential, so there is nothing in its conversation to echo.
 *
 * The help text says what this does and does not promise, because a person who believes the stronger
 * version will hand an untrusted agent a production credential.
 */
export function registerSecretCommands(program: Command, controller: SecretController): void {
  const secret = program
    .command('secret')
    .description('daemon secrets agents can use without ever holding one')
    .addHelpText(
      'after',
      [
        '',
        'Protects against: secrets in transcripts and shell history, a value read off a screen,',
        'a credential written into configuration or copied with it, a tool printing one by accident.',
        '',
        'Does NOT protect against: an agent actively trying to leak a secret it is allowed to use.',
        'It can transform the value first, and masking cannot recognise what it cannot match.',
        '',
        'There is no command that prints a secret. There is no daemon route that could serve one.',
      ].join('\n'),
    );

  secret
    .command('ls', { isDefault: true })
    .description('list the secrets this daemon holds — names and when they changed, never values')
    .option(JSON_FLAG, 'print the protocol document instead of the human listing')
    .action(async (options: SecretListOptions) => {
      await controller.list(options);
    });

  secret
    .command('set <name>')
    .description('store or replace a secret, reading its VALUE from stdin')
    .addHelpText('after', '\n  printf %s "$KEY" | fy secret set ANTHROPIC_KEY\n')
    .action(async (name: string) => {
      await controller.set(name);
    });

  secret
    .command('rm <name>')
    .description('delete a secret')
    .action(async (name: string) => {
      await controller.remove(name);
    });

  secret
    .command('use')
    .description('run a command with secrets in ITS environment; output comes back masked')
    .option('-w, --with <name...>', 'a secret to put in the command environment, by name')
    .option('--cwd <path>', 'where to run (defaults to the current directory)')
    .option('--timeout <ms>', 'how long the command may take')
    .option(JSON_FLAG, 'print the protocol result instead of relaying the streams')
    .argument('<command...>', 'the command to run, after `--`')
    .action(async (command: readonly string[], options: SecretUseOptions) => {
      await controller.use(command, options);
    });
}
