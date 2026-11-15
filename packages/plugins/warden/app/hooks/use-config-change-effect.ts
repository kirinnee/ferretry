/**
 * Run `reread` when a file the Warden's settings card reads moves on a daemon, and when this page comes back into view
 * after being hidden.
 *
 * The kernel publishes `kernel.config-changed` (`ConfigChanged`) on its bus for every config file the caller may read:
 * written, held for the owner, confirmed, discarded, broken, fixed or removed — from another device, `fy`, an agent's
 * config tool, a hand edit or a held edit decided in another tab. The frame carries the plugin, the path, the state and
 * the disk etag, never the text, so the card reads again through the Warden's own client of that daemon. This hears
 * what `warden.config-changed` cannot: that event fires only when the version in effect moves, so a held edit arriving
 * or discarded, or a broken file (the states the card shows as waiting for your approval), said nothing to an open card.
 *
 * It hears `warden.config-changed` too, for the Warden's own file. The kernel shows a config frame only to a caller
 * `GET /v1/config/file` lets read (it needs `fleet.use`), while `GET /v1/warden/config` needs only `warden.use`: a
 * device holding the one and not the other can open the card and would otherwise never be told it moved. Either
 * source wakes the card, and the two arriving together are one reread, not two.
 *
 * Each kind the card names is heard by the file it reads (`KIND_FILES`): the Warden's own `warden.yaml`, Speed-ups'
 * `voice.yaml`, the machine's defaults, its runtimes and its logins. A frame for any other file is ignored. Coming back
 * to a hidden tab reads again too: a frame sent while the feed was down is not replayed, and that is when the owner
 * would otherwise be reading a stale card. The card also reads on mount and after its own save.
 */

import { useDocumentVisible } from '@ferretry/app';
import { ConfigChanged } from '@ferretry/kernel/contract';
import { WardenConfigChanged } from '../../contract/index.ts';
import { useEffect, useRef } from 'react';
import { daemonConnection } from '../lib/machine.ts';
import type { DaemonReach } from '../lib/warden-client-context.tsx';

/** The files each kind of settings the card shows lives in: an exact path, or a folder (ending in `/`) of named files. */
const KIND_FILES: Readonly<Record<string, readonly string[]>> = {
  warden: ['warden.yaml'],
  speedups: ['voice.yaml'],
  machine: ['accounts.yaml', 'runtimes.yaml'],
  // The model picker reads `GET /v1/runtimes`, which assembles runtimes from the profiles, model sets, models and
  // endpoints they name: a change to any of those changes what the card offers.
  runtimes: ['runtimes.yaml', 'runtimes/', 'profiles/', 'model-sets/', 'models/', 'endpoints/'],
  credentials: ['logins/'],
};

/** Whether `path` is a file one of `kinds` reads. A kind the card does not know hears nothing. */
const hearsFile = (kinds: readonly string[], path: string): boolean =>
  kinds.some(kind =>
    (KIND_FILES[kind] ?? []).some(file => (file.endsWith('/') ? path.startsWith(file) : path === file)),
  );

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

    // The kinds' spelling is the key: a caller's inline array must not restart the subscription every render.
    const heard = kinds.join(',');
    useEffect(() => {
      if (reach === undefined) return;
      const wanted = heard === '' ? [] : heard.split(',');
      const stops: (() => void)[] = [];
      let current = true;
      // One reread for a burst: both sources saying the same edit moved arrive in the same turn.
      let pending = false;
      const wake = (): void => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          if (current) latest.current();
        });
      };
      reach(daemonConnection({ daemonId })).then(
        client => {
          if (current) {
            stops.push(
              client.subscribe(ConfigChanged, frame => {
                if (hearsFile(wanted, frame.path)) wake();
              }),
            );
            if (wanted.includes('warden')) stops.push(client.subscribe(WardenConfigChanged, wake));
          }
        },
        // No client for this daemon: the card still reads on return to the tab.
        () => undefined,
      );
      return () => {
        current = false;
        for (const stop of stops) stop();
      };
    }, [daemonId, heard]);
  };
}
