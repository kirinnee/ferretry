/**
 * The three Catalogs screens: `sharing` (a daemon's marketplace, three tabs), `join` (where a share link lands) and
 * `shared` (what is shared with this browser, across publishers). `sharing` is built with the shell's client for one
 * daemon and draws through it. `join` and `shared` are DAEMON-LESS: the shell draws them with no daemon, handed only the
 * daemon-less props (the route's parameters, `navigate`, the address read on demand) — NO client. Their member records
 * ride this half's own member transport, and a machine to install on is only offered where a daemon's client exists
 * (the Sharing page's Subscriptions tab).
 */

import {
  type DaemonlessScreenProps,
  daemonOfClient,
  daemonTitle,
  HOME_HREF,
  distinctDaemonName,
  useDaemonClients,
  useOptionalRouter,
  usePairedDaemons,
  useRouter,
} from '@ferretry/app';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CatalogClient, catalogClientOf } from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { fragmentOf, takeArrival } from '../lib/arrival.ts';
import { daemonConnection } from '../lib/machine.ts';
import { sharedMembers } from '../lib/members.ts';
import { isSharingTab, SHARED_PATH } from '../lib/routes.ts';
import type { InstallMachine } from '../features/shared/shared-item-sheet.tsx';
import type { InstallHost } from '../features/catalogs/install-from-file-sheet.tsx';
import { JoinScreen } from '../features/shared/join-screen.tsx';
import { SharedWithMe } from '../features/shared/shared-with-me.tsx';
import { SharingPage } from '../features/sharing/sharing-page.tsx';
import { DEFAULT_SHARING_TAB } from '../features/sharing/sharing-page.tsx';

const THIS_DAEMON = 'this';

/** Every paired daemon an item could be installed on, named as the ferrets bar names them. */
function useInstallMachines(): readonly InstallMachine[] {
  const paired = usePairedDaemons();
  return useMemo(
    () =>
      paired.map(daemon => ({
        connection: daemonConnection({ daemonId: daemon.daemon, daemonName: daemonTitle(daemon) }),
        name: distinctDaemonName(daemon, paired),
      })),
    [paired],
  );
}

/** Installs go through THAT machine's own client: this one's, or another paired daemon's by the shell. */
function useInstallHost(own: CatalogClient, ownId: string): InstallHost {
  const clientOf = useDaemonClients('catalogs');
  return useMemo(
    () => ({
      createClient: async connection =>
        connection.daemonId === ownId ? own : catalogClientOf(await clientOf(connection.daemonId)),
    }),
    [clientOf, own, ownId],
  );
}

export function createSharingScreen(client: PluginClient) {
  const own = catalogClientOf(client);
  return function SharingScreen({ params }: ScreenProps) {
    const id = daemonOfClient(client) ?? THIS_DAEMON;
    const paired = usePairedDaemons().find(daemon => daemon.daemon === id);
    const connection = useMemo(
      () => daemonConnection({ daemonId: id, daemonName: paired === undefined ? undefined : daemonTitle(paired) }),
      [id, paired],
    );
    const machines = useInstallMachines();
    const installHost = useInstallHost(own, id);
    const { navigate } = useRouter();
    const tab = isSharingTab(params.tab) ? params.tab : undefined;
    return (
      <CatalogClientProvider client={own}>
        <SharingPage
          connection={connection}
          tab={tab ?? DEFAULT_SHARING_TAB}
          onNavigate={navigate}
          members={sharedMembers()}
          machines={machines}
          installHost={installHost}
        />
      </CatalogClientProvider>
    );
  };
}

/**
 * `/join`, where a share link lands. It reads the link's fragment off the address once, on mount, and takes it out of
 * the address (by `replaceState`, keeping the entry's own history state); a second link opened in the same tab is read
 * the same way, from the router's new entry or from `hashchange`, and starts the join over.
 */
export function createJoinScreen() {
  return function JoinRoute({ navigate, location }: DaemonlessScreenProps) {
    const [link, setLink] = useState(() => ({ fragment: fragmentOf(location()), nonce: 0 }));
    const read = useCallback((): void => {
      const fragment = fragmentOf(location());
      if (fragment === '') return;
      takeArrival(globalThis);
      setLink(held => ({ fragment, nonce: held.nonce + 1 }));
    }, [location]);
    const entryKey = useOptionalRouter()?.entryKey;
    const arrived = useRef(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `entryKey` is the trigger; a second link navigates to the same path
    useEffect(() => {
      if (!arrived.current) {
        // The first link is already held by the state above; it only has to leave the address.
        arrived.current = true;
        takeArrival(globalThis);
        return;
      }
      read();
    }, [read, entryKey]);
    useEffect(() => {
      globalThis.addEventListener('hashchange', read);
      return () => globalThis.removeEventListener('hashchange', read);
    }, [read]);
    const now = useCallback(() => new Date(), []);
    return (
      <JoinScreen
        key={link.nonce}
        members={sharedMembers()}
        fragment={link.fragment}
        now={now}
        onShared={() => navigate(SHARED_PATH)}
        onHome={() => navigate(HOME_HREF)}
      />
    );
  };
}

/** `/shared`, what is shared with this browser across publishers. No client, so no machine to install on is offered here. */
export function createSharedScreen() {
  return function SharedRoute({ navigate }: DaemonlessScreenProps) {
    return <SharedWithMe members={sharedMembers()} machines={[]} onHome={() => navigate(HOME_HREF)} />;
  };
}
