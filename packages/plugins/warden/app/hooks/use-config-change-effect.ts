/**
 * Run `reread` when the Warden's settings move on a daemon, and when this page comes back into view after being hidden.
 *
 * The daemon publishes `warden.config-changed` (`WardenConfigChanged`) the moment the kernel's config `watch` hears
 * `warden.yaml` move — another device, `fy`, an agent's config tool, a hand edit, a held edit confirmed in another tab —
 * so an open settings card reads again then, through the Warden's own client of that daemon. Coming back to a hidden
 * tab reads again too: an event sent while the feed was down is not replayed, and that is when the owner would
 * otherwise be reading a stale card. The card also reads on mount and after its own save.
 *
 * Only the `warden` kind has a stream here; the other kinds the card names (Speed-ups, the machine, its runtimes and
 * logins) are other plugins' facts and are heard on return to the tab.
 */

import { useDocumentVisible } from '@ferretry/app';
import { useEffect, useRef } from 'react';
import { WardenConfigChanged } from '../../contract/index.ts';
import { daemonConnection } from '../lib/machine.ts';
import type { DaemonReach } from '../lib/warden-client-context.tsx';

/** The hook for one set of daemons: `reach` gives the Warden's client of a daemon, whose `subscribe` hears its events. */
export function configChangeEffect(
  reach?: DaemonReach,
): (daemonId: string, kinds: readonly string[], reread: () => void) => void {
  return function useConfigChange(daemonId, kinds, reread): void {
    const visible = useDocumentVisible();
    const latest = useRef(reread);
    latest.current = reread;
    const wasVisible = useRef(visible);
    useEffect(() => {
      const returned = visible && !wasVisible.current;
      wasVisible.current = visible;
      if (returned) latest.current();
    }, [visible]);

    const hearsWarden = kinds.includes('warden');
    useEffect(() => {
      if (reach === undefined || !hearsWarden) return;
      let stop: (() => void) | undefined;
      let current = true;
      reach(daemonConnection({ daemonId })).then(
        client => {
          if (current) stop = client.subscribe(WardenConfigChanged, () => latest.current());
        },
        // No client for this daemon: the card still reads on return to the tab.
        () => undefined,
      );
      return () => {
        current = false;
        stop?.();
      };
    }, [daemonId, hearsWarden]);
  };
}
