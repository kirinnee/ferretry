import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type VerbShape, verbHandler } from '../../shell.ts';
import type { GrantCommandOptions, GrantController } from './controller.ts';

/**
 * `fy daemon config …`: the daemon-wide grants.
 *
 * NOT WIRED IN 5.0 YET. Today these verbs mounted onto the `daemon` group; the routes they call
 * (`/v1/grants`) are Gate's (§4.13, §9.2) and no manifest declares `daemon config ls|history|set`, so
 * `cli/index.ts` cannot hand them to the shell. The handlers are ready for whichever manifest takes the
 * verbs.
 *
 * SETUP-TIME-ONLY WOULD BE A TRAP, and that is why this exists at all. Somebody who wants to revoke
 * the UI's ability to change warden settings six months from now must not have to hand-edit a
 * document or re-run an installer. Grants change over the life of a machine.
 */

/** The group's help, kept word for word. */
export function grantsHelp(): string {
  return [
    'read and change what a caller NOT on this host may do',
    '',
    'THIS COMMAND LINE is ungoverned: it holds the admin token, and somebody who can read that file',
    'already has the machine, so gating it would add friction and no safety. These grants apply to a',
    'paired phone, a browser across the network, a session carried over the relay.',
    '',
    'Two axes per capability:',
    '  use        may it exercise the capability at all',
    '  configure  may it change how the capability behaves on this host',
    '',
    `Capabilities: ${CAPABILITY_NAMES.join(', ')}`,
    '',
    'A paired device confirms a dangerous change with a passkey on that device. Turning something ON',
    'is only ever done from this host.',
  ].join('\n');
}

/** `daemon config set`'s help, kept word for word. */
export function grantsSetHelp(bin: string): string {
  return [
    'grant or revoke one capability, by axis',
    '',
    `  ${bin} daemon config set warden --no-configure`,
    `  ${bin} daemon config set browser --no-use --no-configure`,
    `  ${bin} daemon config set fleet --configure`,
  ].join('\n');
}

export const GRANTS_LS_SHAPE: VerbShape = { command: 'ls', args: [], switches: ['json'] };
export const GRANTS_HISTORY_SHAPE: VerbShape = { command: 'history', args: [], switches: ['json'] };
export const GRANTS_SET_SHAPE: VerbShape = {
  command: 'set',
  args: ['capability'],
  switches: ['use', 'no-use', 'configure', 'no-configure'],
};

function grantOptions(switches: Readonly<Record<string, boolean>>): GrantCommandOptions {
  const options: { json?: boolean; use?: boolean; configure?: boolean } = {};
  for (const name of ['json', 'use', 'configure'] as const) {
    const value = switches[name];
    if (value !== undefined) options[name] = value;
  }
  return options;
}

/** The three grant verbs, keyed as a manifest would declare them. */
export function grantVerbs(
  controller: () => GrantController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): {
  readonly 'daemon config ls': VerbHandler;
  readonly 'daemon config history': VerbHandler;
  readonly 'daemon config set': VerbHandler;
} {
  return {
    'daemon config ls': verbHandler(io, exit, GRANTS_LS_SHAPE, async ({ switches }) => {
      await controller().show(grantOptions(switches));
    }),
    'daemon config history': verbHandler(io, exit, GRANTS_HISTORY_SHAPE, async ({ switches }) => {
      await controller().history(grantOptions(switches));
    }),
    'daemon config set': verbHandler(io, exit, GRANTS_SET_SHAPE, async ({ args, switches }) => {
      await controller().set(args[0] as string, grantOptions(switches));
    }),
  };
}
