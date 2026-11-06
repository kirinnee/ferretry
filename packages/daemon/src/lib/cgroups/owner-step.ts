/**
 * The one-time step an owner can take when something above the daemon holds the whole user below the
 * machine's RAM — said in words, with the exact commands, generated from the machine's own facts.
 *
 * WHY IT EXISTS. A box with 61 GiB of RAM and a 48 GiB limit on the user slice gives its ferrets 44 GiB
 * (the budget minus the fixed 4 GiB kept for the daemon), because a fleet sized above that cap would let
 * the slice throttle the daemon again. Lifting the slice's cap to the RAM gives the ferrets RAM − 4 GiB.
 * That needs a system administrator, so Ferretry never does it: it only says how. NOTHING IN THIS PRODUCT
 * RUNS THESE COMMANDS, and nothing at runtime needs `sudo`.
 *
 * Pure: no IO, no clock, no globals.
 */
import { FLEET_RESERVE_BYTES, GIBIBYTE, reserveBytes } from '@ferretry/protocol';
import type { CgroupHostFacts } from './ports.ts';
import { formatBytes } from './view.ts';

export interface OwnerStep {
  /** The sentence that says what is capped and what to do about it. */
  readonly sentence: string;
  /** The commands, one per element, to be run in order. */
  readonly commands: readonly string[];
}

/** The drop-in the commands write. Numbered after the common `50-` so it is read later and wins. */
export const OWNER_STEP_DROP_IN = '60-ferretry-memory.conf';

/** Undefined when nothing above the daemon holds the budget below the machine's RAM. */
export function ownerStep(host: CgroupHostFacts, uid: number): OwnerStep | undefined {
  const cap = host.ceilingCap;
  if (host.platform !== 'linux' || cap === undefined || host.memoryCeilingBytes >= host.physicalBytes) return undefined;
  const unit = cap.unit;
  const what = /^user-\d+\.slice$/u.test(unit) ? 'your user slice' : `the ${unit} limit`;
  const where = cap.dropIn === undefined ? 'set by your systemd configuration' : `set in ${cap.dropIn}`;
  const ferrets = Math.max(0, host.memoryCeilingBytes - reserveBytes(host.memoryCeilingBytes));
  const reserve = formatBytes(FLEET_RESERVE_BYTES);
  const ram = `${Math.floor(host.physicalBytes / GIBIBYTE)}G`;
  const directory = `/etc/systemd/system/${unit}.d`;
  return {
    sentence: `${what} caps memory at ${formatBytes(host.memoryCeilingBytes)} (${where}); ferrets get ${formatBytes(ferrets)}. To give them RAM - ${reserve}, an owner runs:`,
    commands: [
      `sudo mkdir -p ${directory}`,
      `printf '[Slice]\\nMemoryHigh=${ram}\\nMemoryMax=infinity\\n' | sudo tee ${directory}/${OWNER_STEP_DROP_IN}`,
      'sudo systemctl daemon-reload',
      `sudo systemctl set-property ${unit} MemoryHigh=${ram} MemoryMax=infinity`,
      `sudo systemctl set-property user@${uid}.service MemoryLow=${reserve.replace(' GiB', 'G')}`,
    ],
  };
}
