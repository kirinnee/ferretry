import { useEveryDaemon, useScreenHref } from '@ferretry/app';
import { ArrowUpRight } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { MovedStore } from '../lib/moved-store.ts';

/**
 * "Moved to <machine>" on a ferret's row in the fleet list (`ferrets.list-row-mark`). The stub on this machine kept every
 * file; this mark says where the ferret went and links to it. A machine this device is not paired with is named plainly,
 * with no link: a link to nowhere is worse than none.
 */
export function MovedMark({ store, ferret }: { readonly store: MovedStore; readonly ferret: string }) {
  const ledger = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const machines = useEveryDaemon();
  const hrefOf = useScreenHref();
  const gone = ledger.moved[ferret];
  if (gone === undefined) return null;
  const there = machines.find(machine => machine.daemon === gone.daemonId);
  const href = hrefOf(gone.daemonId, 'conversation', 'chat', { ferret: gone.ferretId });
  const words = `Moved to ${there?.machine ?? gone.machine ?? gone.daemonId}`;
  return href === undefined ? (
    <span className="text-meta text-muted" data-moved-to="">
      {words}
    </span>
  ) : (
    <a className="inline-flex items-center gap-1 text-meta text-muted underline" data-moved-to="" href={href}>
      {words}
      <span>· Open there</span>
      <ArrowUpRight aria-hidden="true" size={12} />
    </a>
  );
}
