/**
 * `ferrets.needs-you`, PROVIDED (docs/standards: app hooks, §5.2). Ferrets' list gathers the ferrets that wait on the
 * owner into "Needs you"; which ferrets wait is this half's fact (its open items), so this half answers it, over its
 * own client on one daemon. The value is the roll-up of every ferret's items (`GET /v1/agenda/open`) narrowed to the
 * ferrets with an open item (`agendaSummaryOf`, the daemon's own rule: a parked item or a notice waits on nobody),
 * kept live while a list watches it and re-read when Asks says an ask changed.
 *
 * Nothing is read until something watches, and the last release stops the subscription.
 */

import { AsksChanged } from '@ferretry/core-asks/contract';
import type { FerretNeedsYou, FerretsNeedsYou } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { AgendaRollupStore } from './agenda-rollup.ts';
import { agendaSummaryOf } from './ferret-view.ts';
import { daemonConnection } from './machine.ts';
import { browserListRefreshEnvironment, daemonOfClient, ListRefresh, type ListRefreshEnvironment } from '@ferretry/app';

/** The shortest gap between two reads of the roll-up: a burst of asks is one read. */
const NEEDS_YOU_REFRESH_MIN_MS = 750;

export function createNeedsYou(
  client: Pick<PluginClient, 'call'> & Partial<Pick<PluginClient, 'subscribe'>>,
  environment: ListRefreshEnvironment = browserListRefreshEnvironment,
): FerretsNeedsYou {
  const connection = daemonConnection({ daemonId: daemonOfClient(client) ?? 'this-daemon' });
  const rollup = new AgendaRollupStore(client);
  const refresh = new ListRefresh(() => rollup.read(connection), environment, NEEDS_YOU_REFRESH_MIN_MS);
  const listeners = new Set<() => void>();
  let held: ReadonlyMap<string, FerretNeedsYou> = new Map();
  let watching = 0;
  let stop: (() => void) | undefined;

  const rebuild = (): void => {
    const boards = rollup.getSnapshot().boards.get(connection.daemonId);
    const next = new Map<string, FerretNeedsYou>();
    for (const [ferret, items] of boards ?? []) {
      const summary = agendaSummaryOf(items);
      if (summary !== undefined)
        next.set(ferret, { count: summary.open, latestAt: summary.latestAt, ask: summary.ask });
    }
    held = next;
    for (const listener of listeners) listener();
  };
  rollup.subscribe(rebuild);

  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch: () => {
      watching += 1;
      if (watching === 1) {
        void refresh.request().catch(() => undefined);
        stop = client.subscribe?.(AsksChanged, () => void refresh.invalidate().catch(() => undefined));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watching -= 1;
        if (watching === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    needing: () => held,
  };
}
