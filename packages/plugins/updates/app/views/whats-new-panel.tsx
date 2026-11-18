/**
 * WHO OWNS "WHAT'S NEW": one panel on Settings › This device, two doors into it.
 *
 * The panel's button and the command bar both open the same sheet, so there is one sheet, one "last viewed" record and
 * one answer to "is there something new". The host reads the record once, seeds a first-time device with the newest
 * version it already has (so only the NEXT release shows "New"), and writes the newest version down when the sheet
 * opens. The chips are decided from the record as it stood when the sheet OPENED, so they stay on screen while it is read.
 */

import { Badge, Button, SettingGroup, SettingRow } from '@ferretry/app';
import { useLayoutMode } from '@ferretry/app/ui';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  browserChangelogStorage,
  bundledReleases,
  type ChangelogRelease,
  type ChangelogStorage,
  newVersions,
  readLastViewed,
  seedLastViewed,
  writeLastViewed,
} from '../lib/changelog.ts';
import { whatsNewRequests } from '../lib/whats-new-requests.ts';
import { WhatsNewSheet } from './whats-new-sheet.tsx';

export interface WhatsNewHost {
  readonly releases: readonly ChangelogRelease[];
  /** A release newer than the last one this device viewed exists. */
  readonly unread: boolean;
  /** The newest version this build carries notes for. */
  readonly latest: string | undefined;
  readonly fresh: ReadonlySet<string>;
  readonly shown: boolean;
  readonly open: () => void;
  readonly close: () => void;
}

export function useWhatsNewHost(
  releases: readonly ChangelogRelease[] = bundledReleases(),
  storage: ChangelogStorage | undefined = browserChangelogStorage(),
): WhatsNewHost {
  const [lastViewed, setLastViewed] = useState<string | null>(() => {
    seedLastViewed(storage, releases);
    return readLastViewed(storage);
  });
  const [since, setSince] = useState<{ readonly at: string | null } | null>(null);
  const latest = releases[0]?.version;
  const unread = useMemo(() => newVersions(releases, lastViewed).size > 0, [releases, lastViewed]);
  const open = useCallback(() => {
    setSince({ at: lastViewed });
    if (latest !== undefined) {
      writeLastViewed(storage, latest);
      setLastViewed(latest);
    }
  }, [lastViewed, latest, storage]);
  const close = useCallback(() => setSince(null), []);
  const fresh = useMemo(() => newVersions(releases, since?.at ?? null), [releases, since]);
  return { releases, unread, latest, fresh, shown: since !== null, open, close };
}

/** Settings › This device › What's new: the entry, and the sheet it opens. */
export function WhatsNewPanel() {
  const host = useWhatsNewHost();
  const asked = useSyncExternalStore(whatsNewRequests.subscribe, whatsNewRequests.snapshot);
  const phone = useLayoutMode() === 'drawer';
  const { open } = host;
  useEffect(() => {
    if (!asked) return;
    whatsNewRequests.take();
    open();
  }, [asked, open]);
  return (
    <section aria-label="What’s new" data-whats-new-entry="">
      <SettingGroup label="What’s new">
        <SettingRow
          name="Release notes"
          hint="What changed in the build this device runs"
          control={() => (
            <span className="flex items-center gap-2">
              {host.unread ? (
                <Badge tone="accent" data-whats-new-unread="">
                  New
                </Badge>
              ) : null}
              <Button size="sm" data-whats-new-open="" data-unread={String(host.unread)} onClick={host.open}>
                What’s new{host.latest === undefined ? '' : ` in ${host.latest}`}
              </Button>
            </span>
          )}
        />
      </SettingGroup>
      <WhatsNewSheet
        open={host.shown}
        onClose={host.close}
        releases={host.releases}
        fresh={host.fresh}
        presentation={phone ? 'sheet' : 'dialog'}
      />
    </section>
  );
}
