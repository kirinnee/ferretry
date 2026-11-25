import type { Command } from 'commander';
import type { ConnectorCommandOptions, ConnectorController } from './controller.ts';

/**
 * Mounts `fy connector …` onto the program.
 *
 * `fy connector` alone is the status, so the first thing a person types answers "is it on, and what is waiting".
 */
export function registerConnectorCommands(program: Command, controller: () => ConnectorController): void {
  const bin = program.name();
  const connector = program
    .command('connector')
    .description('see and approve the Claude connector that lets Claude read and drive your ferrets')
    .addHelpText(
      'after',
      [
        '',
        'The connector is OFF until you turn it on: in the app (Settings › Claude connector) or in config/daemon.json (docs/mcp-connector.md).',
        'When Claude signs in, it shows a short match code on a waiting page. Approve only the sign-in whose code',
        'matches the page YOU just opened from Claude — in the app with your passkey, or here at the machine.',
        '',
        `  ${bin} connector                     what is on, what is waiting, who is approved`,
        `  ${bin} connector approve K7Q-2MF     approve the sign-in with that code`,
        `  ${bin} connector deny K7Q-2MF        turn it down`,
        `  ${bin} connector revoke cg_abc123    take an approved client's access away`,
      ].join('\n'),
    );

  connector
    .command('status', { isDefault: true })
    .description('show whether the connector is on, the sign-ins waiting, and the approved clients')
    .option('--json', 'print the protocol document instead of the human report')
    .action(async (options: ConnectorCommandOptions) => {
      await controller().status(options);
    });

  connector
    .command('approve <request>')
    .description('approve a sign-in by its match code or id (no passkey at the machine)')
    .option('--json', 'print the grant as JSON')
    .action(async (request: string, options: ConnectorCommandOptions) => {
      await controller().approve(request, options);
    });

  connector
    .command('deny <request>')
    .description('turn a sign-in down by its match code or id')
    .option('--json', 'print the request as JSON')
    .action(async (request: string, options: ConnectorCommandOptions) => {
      await controller().deny(request, options);
    });

  connector
    .command('revoke <grant>')
    .description('take an approved client’s access away; it is refused on its next call')
    .option('--json', 'print the grant as JSON')
    .action(async (grant: string, options: ConnectorCommandOptions) => {
      await controller().revoke(grant, options);
    });
}
