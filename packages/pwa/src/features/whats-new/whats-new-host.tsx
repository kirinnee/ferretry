/**
 * WHO OWNS "WHAT'S NEW": one host in the app shell, two doors into it.
 *
 * Settings › About and the command palette both ask the shell to open the same sheet, so there is one
 * sheet, one "last viewed" record and one answer to "is there something new". The host reads the
 * record once, seeds a first-time device with the newest version it already has (so only the NEXT
 * release shows "New"), and writes the newest version down when the sheet opens. The chips are decided
 * from the record as it stood when the sheet OPENED, so they stay on screen while it is read.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  browserChangelogStorage,
  bundledReleases,
  type ChangelogRelease,
  type ChangelogStorage,
  newVersions,
  readLastViewed,
  seedLastViewed,
  writeLastViewed,
} from '../../lib/changelog.ts';

export interface WhatsNewEntry {
  readonly open: () => void;
  /** A release newer than the last one this device viewed exists. */
  readonly unread: boolean;
  /** The newest version this build carries notes for. */
  readonly latest: string | undefined;
}

const WhatsNewContext = createContext<WhatsNewEntry | null>(null);
export const WhatsNewProvider = WhatsNewContext.Provider;

/** The shell's door into What's new; `null` where no host is mounted (a test, a standalone harness). */
export const useWhatsNewEntry = (): WhatsNewEntry | null => useContext(WhatsNewContext);

export interface WhatsNewHost {
  readonly entry: WhatsNewEntry;
  readonly releases: readonly ChangelogRelease[];
  readonly fresh: ReadonlySet<string>;
  readonly open: boolean;
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
  const [shown, setShown] = useState<{ readonly since: string | null } | null>(null);
  const latest = releases[0]?.version;
  const unread = useMemo(() => newVersions(releases, lastViewed).size > 0, [releases, lastViewed]);
  const open = useCallback(() => {
    setShown({ since: lastViewed });
    if (latest !== undefined) {
      writeLastViewed(storage, latest);
      setLastViewed(latest);
    }
  }, [lastViewed, latest, storage]);
  const close = useCallback(() => setShown(null), []);
  const fresh = useMemo(() => newVersions(releases, shown?.since ?? null), [releases, shown]);
  const entry = useMemo(() => ({ open, unread, latest }), [open, unread, latest]);
  return { entry, releases, fresh, open: shown !== null, close };
}
