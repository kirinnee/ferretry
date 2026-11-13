/**
 * WHICH TABS SAY "CHANGED" (&F923; docs/agenda.md § The tabs). The marks mean "changed since you last looked", the same
 * basis as the Changes panel: when the machine keeps versions and this device saw an older one, that version is read
 * once and compared with the item now — so a tab edit stays marked even when a later edit only touched the title. Until
 * it is read, when it cannot be read, and when the device has seen the newest version (or never opened the item), the
 * marks fall back to what the item's last edit changed. An older version on screen marks nothing.
 */

import type { AgendaItem } from '@ferretry/core-asks/contract';
import { useEffect, useState } from 'react';
import { changedTabs, tabsChangedSince } from '../../lib/agenda-tab-view.ts';
import type { AgendaVersionsView } from './use-item-lifecycle.ts';

const NONE: ReadonlySet<string> = new Set();

export function useChangedTabs(
  item: AgendaItem,
  versions: AgendaVersionsView | undefined,
  latest: boolean,
): ReadonlySet<string> {
  const seen = versions?.list.seen;
  const since = seen !== undefined && seen < (versions?.list.latest ?? 0) ? seen : undefined;
  const load = versions?.load;
  const [was, setWas] = useState<{ readonly version: number; readonly item: AgendaItem } | null>(null);
  useEffect(() => {
    if (since === undefined || load === undefined) return;
    let live = true;
    load(since)
      .then(version => {
        if (live) setWas({ version: since, item: version });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load, since]);
  if (!latest) return NONE;
  return was !== null && was.version === since ? tabsChangedSince(was.item, item) : changedTabs(item);
}
