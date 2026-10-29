/** The words the Processes tab uses for what the daemon calls a kind and a state. */

import type { SessionProcessKind, SessionProcessState } from '@ferretry/protocol';

export const KIND_LABEL: Readonly<Record<SessionProcessKind, string>> = {
  command: 'command',
  background: 'background',
  server: 'server',
  helper: 'helper',
};

/** What a kind means to someone who has never seen the word, for the chip's tooltip and screen-reader text. */
export const KIND_MEANING: Readonly<Record<SessionProcessKind, string>> = {
  command: 'A command the agent is running now and waiting on',
  background: 'Runs in the background',
  server: 'Server — listening for connections',
  helper: 'Kept by the agent (helper)',
};

export const STATE_LABEL: Readonly<Record<SessionProcessState, string>> = {
  running: 'Running',
  sleeping: 'Waiting',
  stopped: 'Paused',
  zombie: 'Defunct',
  exited: 'Ended',
};

export type DotTone = 'ok' | 'muted' | 'warn' | 'err' | 'ended';

/** The colour of a row's status dot: running green, waiting muted, paused amber, defunct or failed red, ended grey. */
export const dotTone = (process: {
  readonly state: SessionProcessState;
  readonly exit?: { readonly failed: boolean };
}): DotTone => {
  if (process.state === 'running') return 'ok';
  if (process.state === 'sleeping') return 'muted';
  if (process.state === 'stopped') return 'warn';
  if (process.state === 'zombie') return 'err';
  return process.exit?.failed === true ? 'err' : 'ended';
};
