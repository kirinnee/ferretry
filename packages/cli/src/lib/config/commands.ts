import type { Command } from 'commander';
import type { ConfigCommandOptions, ConfigController, ConfigWriteOptions } from './controller.ts';

const OVERVIEW = `This machine's settings live in YAML files: machine.yaml, logins/, components/,
profiles/, runtimes/, warden.yaml, learning.yaml and voice.yaml. Edit them with
any editor, then run "config check". A secret value never goes in a file: store
it with "secret set NAME" and write \${secret:NAME}. An edit that loosens what the
machine may spend or what agents may do waits for "config confirm".`;

/** Mounts `fy config …` (docs/config-files.md). `check` is the default verb. */
export function registerConfigCommands(program: Command, controller: ConfigController): void {
  const config = program
    .command('config')
    .description("check and find this machine's configuration files")
    .addHelpText('after', `\n${OVERVIEW}`);

  config
    .command('check', { isDefault: true })
    .description('check every configuration file, as the daemon would; exits non-zero on an error')
    .option('--json', 'print the report as JSON')
    .action(async (options: ConfigCommandOptions) => {
      await controller.check(options);
    });

  config
    .command('path')
    .description('print the configuration directory, or one file in it')
    .argument('[file]', 'a file, relative to the directory: machine.yaml, logins/<id>.yaml, …')
    .action((file: string | undefined) => {
      controller.path(file);
    });

  config
    .command('schema')
    .description('print the JSON Schema of one kind of file, or list the kinds')
    .argument('[kind]', 'machine, login, component-mcp, profile, runtime, warden, learning, voice, …')
    .action((kind: string | undefined) => {
      controller.schema(kind);
    });

  config
    .command('status')
    .description('what the daemon has in effect: every file, every problem, every change waiting')
    .option('--json', 'print the payload as JSON')
    .action(async (options: ConfigCommandOptions) => {
      await controller.status(options);
    });

  config
    .command('show')
    .description('show one file as the daemon holds it: where it stands, its etag, its issues and its text')
    .argument('<file>', 'a file, relative to the directory: machine.yaml, logins/<id>.yaml, …')
    .option('--json', 'print the payload as JSON')
    .action(async (file: string, options: ConfigCommandOptions) => {
      await controller.show(file, options);
    });

  config
    .command('write')
    .description('write one file through the daemon from stdin; refused unless it checks')
    .argument('<file>', 'a file, relative to the directory')
    .option('--if-match <etag>', 'refuse if the file changed since this etag (from "config show")')
    .action(async (file: string, options: ConfigWriteOptions) => {
      await controller.write(file, options);
    });

  config
    .command('confirm')
    .description('put into effect a change that loosens what this machine allows, or list what waits')
    .argument('[file]', 'the file whose waiting change to confirm')
    .action(async (file: string | undefined) => {
      await controller.confirm(file);
    });

  config
    .command('guide')
    .description('print the built-in "Set up Ferretry" skill (a SKILL.md)')
    .action(() => {
      controller.guide();
    });
}
