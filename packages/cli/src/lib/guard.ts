/**
 * The client guard (§9.6): before every route call, tool call and subscription, the owning plugin's inventory entry
 * must be present, on, and carry the same effective contract hash this `fy` was compiled with. Otherwise the call is
 * blocked WITHOUT being sent and fails `plugin_paused`. Pure: the inventory is passed in.
 */
import { KERNEL_REFUSALS, PROTOCOL, type PluginInventory } from '@ferretry/kernel/contract';
import { EXIT, ShellError } from './errors.ts';

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'daemon-older' | 'daemon-newer' | 'missing' | 'off' | 'different' };

/** The compiled-in contract hash of each plugin of this `fy`. */
export type CompiledContracts = Readonly<Record<string, string>>;

export function judgePlugin(inventory: PluginInventory, compiled: CompiledContracts, id: string): GuardVerdict {
  if (inventory.protocol < PROTOCOL) return { ok: false, reason: 'daemon-older' };
  if (inventory.protocol > PROTOCOL) return { ok: false, reason: 'daemon-newer' };
  const entry = inventory.plugins.find(candidate => candidate.id === id);
  if (entry === undefined) return { ok: false, reason: 'missing' };
  if (!entry.on) return { ok: false, reason: 'off' };
  const ours = compiled[id];
  if (ours === undefined || ours !== entry.contract) return { ok: false, reason: 'different' };
  return { ok: true };
}

/** What to say, in the owner's words, with the command that fixes it. */
export function pausedSentence(
  verdict: Extract<GuardVerdict, { ok: false }>,
  title: string,
  id: string,
  binary: string,
): string {
  switch (verdict.reason) {
    case 'daemon-older':
      return `This daemon needs an update before ${binary} can talk to it: restart it on the new build with \`${binary} daemon restart\`.`;
    case 'daemon-newer':
      return `This daemon is newer than ${binary}: update ${binary} to use it.`;
    case 'missing':
      return `This daemon does not have ${title}: update the daemon, then try again (\`${binary} daemon restart\`).`;
    case 'off':
      return `${title} is turned off: turn it on with \`${binary} plugin on ${id}\`.`;
    case 'different':
      return `${title} differs between ${binary} and the daemon: restart the daemon with \`${binary} daemon restart\`.`;
  }
}

/** Thrown where a blocked call would have been sent. `code` is `plugin_paused`, a client-side code only. */
export class PluginPausedError extends ShellError {
  readonly code = KERNEL_REFUSALS.pluginPaused.code;

  constructor(
    readonly plugin: string,
    readonly reason: Extract<GuardVerdict, { ok: false }>['reason'],
    message: string,
  ) {
    super(message, EXIT.unavailable);
    this.name = 'PluginPausedError';
  }
}
