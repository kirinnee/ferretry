/**
 * The client guard (§9.6): before every route call, tool call and subscription, every core package (`CORE_IDS`) and the
 * owning plugin must be present, on, and carry the same effective contract hash this `fy` was compiled with. A core
 * piece that differs blocks everything, whatever a plugin itself needs. Otherwise the call is blocked WITHOUT being
 * sent and fails `plugin_paused`. Pure: the inventory is passed in.
 */
import { CORE_IDS, KERNEL_REFUSALS, PROTOCOL, type PluginInventory } from '@ferretry/kernel/contract';
import { EXIT, ShellError } from './errors.ts';

type EntryReason = 'missing' | 'off' | 'different';

/** One package's own standing on the daemon. */
export type PluginVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'daemon-older' | 'daemon-newer' | EntryReason };

export type GuardVerdict =
  | PluginVerdict
  /** A core package is not as this `fy` was built: nothing may be sent. `core` names it, `why` says how. */
  | { readonly ok: false; readonly reason: 'core'; readonly core: string; readonly why: EntryReason };

/** The compiled-in contract hash of each plugin of this `fy`. */
export type CompiledContracts = Readonly<Record<string, string>>;

export function judgePlugin(inventory: PluginInventory, compiled: CompiledContracts, id: string): PluginVerdict {
  if (inventory.protocol < PROTOCOL) return { ok: false, reason: 'daemon-older' };
  if (inventory.protocol > PROTOCOL) return { ok: false, reason: 'daemon-newer' };
  const entry = inventory.plugins.find(candidate => candidate.id === id);
  if (entry === undefined) return { ok: false, reason: 'missing' };
  if (!entry.on) return { ok: false, reason: 'off' };
  const ours = compiled[id];
  if (ours === undefined || ours !== entry.contract) return { ok: false, reason: 'different' };
  return { ok: true };
}

/**
 * The verdict for one call owned by `id`: the protocol, then EVERY core package, then `id` itself. A core package this
 * `fy` has no compiled hash for counts as different: guessing wrong in that direction sends to a daemon nobody checked.
 */
export function judgeCall(inventory: PluginInventory, compiled: CompiledContracts, id: string): GuardVerdict {
  for (const core of CORE_IDS) {
    const verdict = judgePlugin(inventory, compiled, core);
    if (verdict.ok) continue;
    if (verdict.reason === 'daemon-older' || verdict.reason === 'daemon-newer') return verdict;
    return { ok: false, reason: 'core', core, why: verdict.reason };
  }
  return judgePlugin(inventory, compiled, id);
}

/** What to say, in the owner's words, with the command that fixes it. For `core`, `title` and `id` name the core package. */
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
    case 'core':
      return verdict.why === 'missing'
        ? `This daemon does not have ${title}, which everything needs, so ${binary} sends nothing to it: update the daemon, then try again (\`${binary} daemon restart\`).`
        : `${title}, which everything needs, ${verdict.why === 'off' ? 'is not running on this daemon' : `differs between ${binary} and the daemon`}, so ${binary} sends nothing to it: restart the daemon with \`${binary} daemon restart\`, or update ${binary}.`;
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
