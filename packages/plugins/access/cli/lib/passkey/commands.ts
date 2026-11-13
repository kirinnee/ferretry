import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type VerbShape, verbHandler } from '../../shell.ts';
import type { PasskeyController } from './controller.ts';

/** The help overview: why this verb exists, because the reason is the part nobody can guess. */
export function overview(binaryName: string): string {
  return `A paired device proves its owner with a passkey, and it may add its first one only in the
ten minutes after pairing. A device that missed that window, or lost the authenticator that held its
passkey, could never step up again — and the browser cannot fix that itself, because a browser is
never "at the machine": a tunnel or a proxy to the daemon is indistinguishable from one on the host.

So the OWNER re-opens the window here, at the machine, with the host's admin token. It lasts ten
minutes, admits ONE passkey for that one device, and is recorded in the audit journal.

  ${binaryName} passkey window "Pixel 8"
  ${binaryName} passkey window fy_device_id_…

<device> is a paired device's id, or its name when exactly one paired device has that name.

There is no --json: the whole answer is one sentence and a time, and a script that needs to know
the window opened has the exit code.`;
}

/** The group's help, as commander printed it for `fy passkey` with no verb. */
export function passkeyHelp(binaryName: string): string {
  return [
    `Usage: ${binaryName} passkey [command]`,
    '',
    "recover a paired device that cannot add a passkey — the owner's verb, run at the machine",
    '',
    'Commands:',
    "  window <device>  re-open one paired device's ten-minute window to add a passkey",
    '',
    overview(binaryName),
  ].join('\n');
}

/** `passkey` alone takes nothing: it is the group. */
const PASSKEY_SHAPE: VerbShape = { command: 'passkey', args: [], switches: [] };
const PASSKEY_WINDOW_SHAPE: VerbShape = { command: 'window', args: ['device'], switches: [] };

/**
 * `fy passkey` and `fy passkey window <device>`.
 *
 * `passkey` ALONE IS A GROUP WITH NO ACTION, so it answers as commander did: its help on stderr and exit 1, because
 * nothing the owner asked for happened.
 */
export function passkeyVerbs(
  controller: () => PasskeyController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
  binaryName: string,
): { readonly passkey: VerbHandler; readonly 'passkey window': VerbHandler } {
  return {
    passkey: verbHandler(io, exit, PASSKEY_SHAPE, async () => {
      io.err(`${passkeyHelp(binaryName)}\n`);
      exit.setExitCode(1);
    }),
    'passkey window': verbHandler(io, exit, PASSKEY_WINDOW_SHAPE, async ({ args }) => {
      await controller().window(args[0] as string);
    }),
  };
}
