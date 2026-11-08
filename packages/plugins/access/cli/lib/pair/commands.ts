import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type VerbShape, verbHandler } from '../../shell.ts';
import type { PairController, PairOptions } from './controller.ts';

/** The help overview. */
export function overview(bin: string): string {
  return `Pairing gives one device its own token for this host. The daemon mints a code that
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

A newly paired device can do anything on this machine — once it unlocks it
with its passkey. It can do nothing at all before that, and each unlock lasts
the machine's unlock period (8 hours unless you changed it). --limited pairs a
device that can only read the fleet and chat with sessions; widen it later with
\`${bin} device grant\`. Nothing about either is in the QR or the link; the daemon
holds it with the code.

There is no --json: the only secret on this screen is the code, and a flag
whose purpose is to be redirected into a file is a flag that puts it there.`;
}

/** The flags, word for word as commander listed them, for the help a 5.0 shell will render. */
export const PAIR_OPTIONS_HELP: readonly (readonly [string, string])[] = [
  ['--large', 'draw the QR at full size, for a camera that will not focus on the compact one'],
  ['--no-wait', 'print the code and exit instead of staying to report the scan'],
  ['--limited', 'give the new device read-and-chat only, instead of full access behind its unlock'],
  ['--open', "open the pairing link in this host's browser — for when the daemon and the browser are the same machine"],
];

/**
 * What `fy pair` accepts, and nothing else: no `--name` (the device names itself when it redeems), no `--json`
 * (the only secret here is the code) and no `--full` (full is the default, P46).
 */
const PAIR_SHAPE: VerbShape = { command: 'pair', args: [], switches: ['large', 'no-wait', 'limited', 'open'] };

/** The flags as `PairController` reads them: `wait` is `false` only for `--no-wait`. */
function pairOptions(switches: Readonly<Record<string, boolean>>): PairOptions {
  const options: { wait?: boolean; large?: boolean; open?: boolean; limited?: boolean } = {};
  for (const name of ['wait', 'large', 'open', 'limited'] as const) {
    const value = switches[name];
    if (value !== undefined) options[name] = value;
  }
  return options;
}

/**
 * `fy pair`. A single verb rather than a group. Listing paired devices and changing what each may do is the other
 * half of this subsystem and lives under `fy device` (`../device/commands.ts`), which reads `GET /v1/pair/devices`.
 */
export function pairVerb(controller: () => PairController, io: Pick<TerminalIo, 'err'>, exit: ExitStatus): VerbHandler {
  return verbHandler(io, exit, PAIR_SHAPE, async ({ switches }) => {
    await controller().pair(pairOptions(switches));
  });
}
