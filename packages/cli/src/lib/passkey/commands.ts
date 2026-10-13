import type { Command } from 'commander';
import type { PasskeyController } from './controller.ts';

/** The help overview: why this verb exists, because the reason is the part nobody can guess. */
function overview(binaryName: string): string {
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

/** Mounts `fy passkey window <device>` onto the program. */
export function registerPasskeyCommands(program: Command, controller: PasskeyController): void {
  const bin = program.name();
  program
    .command('passkey')
    .description("recover a paired device that cannot add a passkey — the owner's verb, run at the machine")
    .addHelpText('after', `\n${overview(bin)}`)
    .command('window <device>')
    .description("re-open one paired device's ten-minute window to add a passkey")
    .action(async (device: string) => {
      await controller.window(device);
    });
}
