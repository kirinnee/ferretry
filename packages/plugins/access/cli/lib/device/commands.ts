import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type VerbShape, verbHandler } from '../../shell.ts';
import type { DeviceCommandOptions, DeviceController } from './controller.ts';

/**
 * `fy device …`, as the 5.0 shell hands it over: the manifest declares `device ls`, `device grant` and
 * `device revoke`, and each is read here the way commander read it today.
 *
 * `list` WAS AN ALIAS FOR `ls`, and `ls` the group's default; the manifest declares neither (a shell
 * alias is the lead's call), so only `device ls` is wired.
 */

/** The group's help, kept word for word. The 5.0 shell renders no per-verb long help yet. */
export function deviceHelp(bin: string): string {
  return [
    'see and change what each paired device may do',
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
    `Capabilities: ${CAPABILITY_NAMES.join(', ')}`,
  ].join('\n');
}

/** `device grant`'s help, kept word for word. */
export function deviceGrantHelp(bin: string): string {
  return [
    'grant or revoke one capability on one device, by axis',
    '',
    '<device> is a device id, or a device name when exactly one device has that name.',
    '',
    `  ${bin} device grant "Pixel 9" terminal --use`,
    `  ${bin} device grant "Pixel 9" filesystem --use --configure`,
    `  ${bin} device grant "Pixel 9" terminal --no-use`,
  ].join('\n');
}

/** `device revoke`'s help, kept word for word. */
export function deviceRevokeHelp(bin: string): string {
  return [
    'remove a paired device: close its sessions and forget its passkeys',
    '',
    "This is the at-the-machine way to remove a stolen phone: it needs no browser, only the host's admin",
    'token. The device must be paired again to return.',
    '',
    '<device> is a device id, or a device name when exactly one device has that name.',
    '',
    `  ${bin} device revoke "Pixel 9"`,
    `  ${bin} device revoke "Pixel 9" --yes`,
  ].join('\n');
}

/** `--json`: print the protocol document instead of the human report. */
const DEVICE_LS_SHAPE: VerbShape = { command: 'ls', args: [], switches: ['json'] };

/** `--use`/`--no-use` and `--configure`/`--no-configure`; absent leaves that axis alone. */
const DEVICE_GRANT_SHAPE: VerbShape = {
  command: 'grant',
  args: ['device', 'capability'],
  switches: ['use', 'no-use', 'configure', 'no-configure'],
};

/** `-y, --yes`: skip the typed confirmation; required when not on a terminal. */
const DEVICE_REVOKE_SHAPE: VerbShape = {
  command: 'revoke',
  args: ['device'],
  switches: ['yes'],
  aliases: { y: 'yes' },
};

/** The flags as `DeviceController` reads them: only the ones given. */
function deviceOptions(switches: Readonly<Record<string, boolean>>): DeviceCommandOptions {
  const options: { json?: boolean; use?: boolean; configure?: boolean; yes?: boolean } = {};
  for (const name of ['json', 'use', 'configure', 'yes'] as const) {
    const value = switches[name];
    if (value !== undefined) options[name] = value;
  }
  return options;
}

/** The three device verbs. `controller` is built on first use, as today. */
export function deviceVerbs(
  controller: () => DeviceController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): { readonly 'device ls': VerbHandler; readonly 'device grant': VerbHandler; readonly 'device revoke': VerbHandler } {
  return {
    'device ls': verbHandler(io, exit, DEVICE_LS_SHAPE, async ({ switches }) => {
      await controller().list(deviceOptions(switches));
    }),
    'device grant': verbHandler(io, exit, DEVICE_GRANT_SHAPE, async ({ args, switches }) => {
      await controller().grant(args[0] as string, args[1] as string, deviceOptions(switches));
    }),
    'device revoke': verbHandler(io, exit, DEVICE_REVOKE_SHAPE, async ({ args, switches }) => {
      await controller().revoke(args[0] as string, deviceOptions(switches));
    }),
  };
}
