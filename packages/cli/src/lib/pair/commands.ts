import type { Command } from 'commander';
import type { PairController, PairOptions } from './controller.ts';

const OVERVIEW = `Pairing gives one device its own token for this host. The daemon mints a code that
lives for two minutes and works once; the QR here carries that code, the
daemon's address and its key fingerprint in a URL fragment, which browsers
never send to a server. Scanning it with the phone's own camera app opens
Ferretry already filled in.

The device names itself when it redeems, so there is nothing to name here.

When the daemon and the browser are the SAME machine there is nobody to
scan anything, so --open hands the link to this host's browser and the
reader lands in Ferretry already paired. It is opt-in: opening a window
on a host whose operator did not ask for one is a side effect nobody
consented to, and on a headless box it is worse than useless. If the host
cannot open a browser, the QR and the link above are untouched.

There is no --json: the only secret on this screen is the code, and a flag
whose purpose is to be redirected into a file is a flag that puts it there.`;

/**
 * Mounts `fy pair` onto the program.
 *
 * A single verb rather than a group. Listing and revoking paired devices is the other half of this
 * subsystem and belongs with the daemon's device registry, which serves no route yet; a `pair ls` that
 * could only ever answer "nothing" would read as a fact rather than as a missing feature.
 */
export function registerPairCommands(program: Command, controller: PairController): void {
  program
    .command('pair')
    .description('pair a phone or another device with this host')
    .option('--large', 'draw the QR at full size, for a camera that will not focus on the compact one')
    .option('--no-wait', 'print the code and exit instead of staying to report the scan')
    .option(
      '--open',
      "open the pairing link in this host's browser — for when the daemon and the browser are the same machine",
    )
    .addHelpText('after', `\n${OVERVIEW}`)
    .action(async (flags: PairOptions) => {
      await controller.pair(flags);
    });
}
