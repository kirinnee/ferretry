/**
 * What the Runtimes tab reads, and how its pages are addressed.
 *
 * ## One read of four answers
 *
 * The tab needs one picture — the logins, the runtimes on them, the profiles a runtime can pick, and the parts those
 * profiles are made of — so one hook reads all four through the client bound to this machine and re-reads after every
 * change. Nothing is patched optimistically: what is on screen is what the machine answered last. A read is made when
 * the tab opens, when the person retries, after a change they made, and when the machine says its configuration moved
 * — from another device, `fy`, a hand edit or a sign-in that finished on its own; never on a timer.
 *
 * ## A page is a link
 *
 * A runtime's page is the tab's link plus one more segment — `#machines/<machine>/runtimes/<name>` — so it can be
 * shared, Back works, and another tab can link to it. The shell reads only the first three segments, so it still
 * opens the right tab.
 */

import { type LoginList, LoginListSchema } from '@ferretry/plugin-logins/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentCatalog, LayeredProfileCatalog, RuntimeCatalog } from '../../../../contract/index.ts';
import { useMachineChanges } from '../../../hooks/use-machine-changes.ts';
import type { LiveRuntimesClient, RuntimesClient } from '../../../lib/client.ts';
import { readComponents, readProfiles, readRuntimeCatalog } from '../components/account-catalog.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { MACHINES_SECTION, type MachineTabId, machineHash } from '../shell/machine-route.ts';

export interface MachineData {
  readonly credentials: LoginList;
  readonly runtimes: RuntimeCatalog;
  readonly profiles: LayeredProfileCatalog;
  /** Only badges come from it, so a machine that cannot answer it still shows its runtimes. */
  readonly components: ComponentCatalog | null;
}

type MachineDataState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: MachineData }
  /** The read failed. What was last seen, if anything, stays on screen with the sentence. */
  | { readonly kind: 'failed'; readonly sentence: string; readonly last: MachineData | null };

/** Every login on this machine (Logins' list). */
export const readLogins = async (client: RuntimesClient): Promise<LoginList> =>
  LoginListSchema.parse(await client.call('GET /v1/logins'));

/** The four reads, together. Throws what the first failing read threw. */
export const readMachineData = async (client: RuntimesClient): Promise<MachineData> => {
  const [credentials, runtimes, profiles, components] = await Promise.all([
    readLogins(client),
    readRuntimeCatalog(client),
    readProfiles(client),
    readComponents(client).catch(() => null),
  ]);
  return { credentials, runtimes, profiles, components };
};

export interface UseMachineData {
  readonly state: MachineDataState;
  /** The newest answer, from either a ready read or the one kept beside a failure. */
  readonly data: MachineData | null;
  /** Read again; resolves with the new answer, or `null` when it failed. */
  readonly reload: () => Promise<MachineData | null>;
}

export function useMachineData(client: LiveRuntimesClient): UseMachineData {
  const [state, setState] = useState<MachineDataState>({ kind: 'loading' });
  const last = useRef<MachineData | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async (): Promise<MachineData | null> => {
    generation.current += 1;
    const mine = generation.current;
    try {
      const data = await readMachineData(client);
      if (mine !== generation.current) return data;
      last.current = data;
      setState({ kind: 'ready', data });
      return data;
    } catch (error) {
      if (mine === generation.current)
        setState({ kind: 'failed', sentence: changeRefusalSentence(error), last: last.current });
      return null;
    }
  }, [client]);

  useEffect(() => {
    last.current = null;
    setState({ kind: 'loading' });
    void reload();
  }, [reload]);
  // A change made anywhere else — another device, `fy`, a hand edit, a sign-in finishing — is read the moment the
  // machine says it happened, keeping what is on screen until the answer lands.
  useMachineChanges(client, ['runtimes', 'catalogue', 'logins'], () => void reload());

  const data = state.kind === 'ready' ? state.data : state.kind === 'failed' ? state.last : null;
  return { state, data, reload };
}

/** The page segment of a Machines link (`#machines/<machine>/<tab>/<item>`), or `null`. */
export const machineDetailFromHash = (hash: string, tab: MachineTabId): string | null => {
  const [section, , tabSegment, item] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION || tabSegment !== tab || item === undefined || item === '') return null;
  try {
    return decodeURIComponent(item);
  } catch {
    return null;
  }
};

/** The link to one page in a tab, or to the tab itself. */
export const machineDetailHash = (machine: string, tab: MachineTabId, item?: string): string =>
  item === undefined ? machineHash(machine, tab) : `${machineHash(machine, tab)}/${encodeURIComponent(item)}`;

/**
 * Which page of this tab the link names, and a way to open another. Follows the browser's Back and Forward, because
 * the page is in the address.
 */
export function useMachineDetail(
  machine: string,
  tab: MachineTabId,
  browser: Window = window,
): readonly [string | null, (item: string | null) => void] {
  const [detail, setDetail] = useState(() => machineDetailFromHash(browser.location.hash, tab));
  useEffect(() => {
    const read = (): void => setDetail(machineDetailFromHash(browser.location.hash, tab));
    read();
    browser.addEventListener('hashchange', read);
    return () => browser.removeEventListener('hashchange', read);
  }, [browser, tab]);
  const open = useCallback(
    (item: string | null): void => {
      browser.location.hash = machineDetailHash(machine, tab, item ?? undefined);
      setDetail(item);
    },
    [browser, machine, tab],
  );
  return [detail, open];
}
