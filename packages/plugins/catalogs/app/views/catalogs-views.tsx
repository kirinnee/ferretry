/**
 * The three Catalogs screens: `sharing` (a daemon's marketplace, three tabs), `join` (where a share link lands) and
 * `shared` (what is shared with this browser, across publishers). Each is built with the shell's client for one daemon
 * and draws through it; `join` and `shared` use no daemon of their own (member records ride the shell's member
 * transport), and a daemon is only needed to say where an install goes.
 */

import {
  daemonOfClient,
  daemonTitle,
  HOME_HREF,
  distinctDaemonName,
  useDaemonClients,
  usePairedDaemons,
  useRouter,
} from '@ferretry/app';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CatalogClient, catalogClientOf } from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { heldArrival, holdArrival, releaseArrival } from '../lib/arrival.ts';
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

export function createJoinScreen(client: PluginClient) {
  const own = catalogClientOf(client);
  return function JoinRoute(_props: ScreenProps) {
    const { navigate, entryKey } = useRouter();
    // The address was already emptied when the half was built (`watchArrivals`); the code is only HELD here, so a render
    // React throws away loses nothing. It is released once an effect has it.
    const [link, setLink] = useState(() => ({ fragment: heldArrival(), nonce: 0 }));
    const read = useCallback((): void => {
      holdArrival(globalThis);
      const fragment = releaseArrival();
      if (fragment !== '') setLink(held => ({ fragment, nonce: held.nonce + 1 }));
    }, []);
    const arrived = useRef(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `entryKey` is the trigger; a second link navigates to the same path
    useEffect(() => {
      if (!arrived.current) {
        arrived.current = true;
        releaseArrival(); // the first link is already on screen: release it, do not restart the join with it
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
      <CatalogClientProvider client={own}>
        <JoinScreen
          key={link.nonce}
          members={sharedMembers()}
          fragment={link.fragment}
          now={now}
          onShared={() => navigate(SHARED_PATH)}
          onHome={() => navigate(HOME_HREF)}
        />
      </CatalogClientProvider>
    );
  };
}

export function createSharedScreen(client: PluginClient) {
  const own = catalogClientOf(client);
  return function SharedRoute(_props: ScreenProps) {
    const { navigate } = useRouter();
    const machines = useInstallMachines();
    const installHost = useInstallHost(own, daemonOfClient(client) ?? THIS_DAEMON);
    return (
      <CatalogClientProvider client={own}>
        <SharedWithMe
          members={sharedMembers()}
          machines={machines}
          installHost={installHost}
          onHome={() => navigate(HOME_HREF)}
        />
      </CatalogClientProvider>
    );
  };
}
