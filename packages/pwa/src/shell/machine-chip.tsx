/**
 * THE TWO MARKS THE ALL-MACHINES LIST NAMES A MACHINE WITH.
 *
 * - `MachineChip`: a small quiet pill with the machine's name, on a row ONLY where nothing around the
 *   row already says which machine it is on — inside Needs you. Under a machine heading it would say
 *   the heading again on every line.
 * - `MachineReachDot`: the heading's dot. Filled for a machine that answered, hollow for one that did
 *   not. It is decoration: the heading says the reach in words beside it (`MachineReachWords`), so the
 *   colour is never the only signal and a screen reader hears it once.
 */

import type { ListReach } from '../lib/all-machines.ts';
import { cn } from '../lib/class-names.ts';

export function MachineChip({ name, className }: { readonly name: string; readonly className?: string }) {
  return (
    <span className={cn('fy-machine-chip', className)} data-machine-chip="" title={`On ${name}`}>
      {name}
    </span>
  );
}

export function MachineReachDot({ reach }: { readonly reach: ListReach }) {
  return <span aria-hidden="true" className="fy-machine-dot" data-reach={reach} />;
}

/**
 * The reach in words after the machine's name: "offline · last seen 5m", "locked · …", "reading…". A
 * machine that is simply online shows nothing, and is still said to be online to a screen reader.
 */
export function MachineReachWords({ label, className }: { readonly label: string; readonly className: string }) {
  return label === '' ? <span className="sr-only">online</span> : <span className={className}>{label}</span>;
}
