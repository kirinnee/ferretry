import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { DeviceCommandOptions, DeviceController } from './controller.ts';

/**
 * Mounts `fy device …` onto the program.
 *
 * `list` IS AN ALIAS FOR `ls`, as everywhere else in this command line.
 */
export function registerDeviceCommands(program: Command, controller: () => DeviceController): void {
  const bin = program.name();
  const device = program
    .command('device')
    .description('see and change what each paired device may do')
    .addHelpText(
      'after',
      [
        '',
        'THIS COMMAND LINE is ungoverned: it holds the admin token, and somebody who can read that file',
        'already has the machine, so it may widen or narrow any device without a confirmation.',
        '',
        'A newly paired device holds FULL grants, and can use none of them until it unlocks with its passkey;',
        `each unlock lasts the machine's unlock period. \`${bin} pair --limited\` pairs one with fleet.use only:`,
        'it can read the fleet and chat with sessions, and nothing else until somebody widens it.',
        '',
        `What a device may do is BOTH its own grants AND the daemon-wide ones (\`${bin} daemon config\`):`,
        'the effective answer is the narrower of the two, axis by axis.',
        '',
        'A remote device may widen ANOTHER device only if it holds pairing.configure, holds the capability',
        'itself, and confirms with a passkey step-up on that device.',
        '',
        `A stolen or lost phone is removed HERE, at the machine: \`${bin} device revoke <device>\` takes its access away,`,
        'closes every session it has open and forgets its passkeys, with no browser involved. It is recorded in the audit',
        'journal.',
        '',
        `Capabilities: ${DAEMON_CAPABILITIES.join(', ')}`,
      ].join('\n'),
    );

  device
    .command('ls', { isDefault: true })
    .alias('list')
    .description('show every paired device and what each one may do')
    .option('--json', 'print the protocol document instead of the human report')
    .action(async (options: DeviceCommandOptions) => {
      await controller().list(options);
    });

  device
    .command('grant <device> <capability>')
    .description('grant or revoke one capability on one device, by axis')
    .option('--use', 'let this device exercise the capability')
    .option('--no-use', 'stop this device exercising the capability')
    .option('--configure', 'let this device change the capability’s host settings')
    .option('--no-configure', 'stop this device changing the capability’s host settings')
    .addHelpText(
      'after',
      [
        '',
        '<device> is a device id, or a device name when exactly one device has that name.',
        '',
        `  ${bin} device grant "Pixel 9" terminal --use`,
        `  ${bin} device grant "Pixel 9" filesystem --use --configure`,
        `  ${bin} device grant "Pixel 9" terminal --no-use`,
      ].join('\n'),
    )
    .action(async (query: string, capability: string, options: DeviceCommandOptions) => {
      await controller().grant(query, capability, options);
    });

  device
    .command('revoke <device>')
    .description('remove a paired device: close its sessions and forget its passkeys')
    .option('-y, --yes', 'skip the typed confirmation; required when not on a terminal')
    .addHelpText(
      'after',
      [
        '',
        "This is the at-the-machine way to remove a stolen phone: it needs no browser, only the host's admin",
        'token. The device must be paired again to return.',
        '',
        '<device> is a device id, or a device name when exactly one device has that name.',
        '',
        `  ${bin} device revoke "Pixel 9"`,
        `  ${bin} device revoke "Pixel 9" --yes`,
      ].join('\n'),
    )
    .action(async (query: string, options: DeviceCommandOptions) => {
      await controller().revoke(query, options);
    });
}
