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
import type { ArrivalHold } from '../lib/arrival.ts';
import { daemonConnection } from '../lib/machine.ts';
import { sharedMembers } from '../lib/members.ts';
import { fetchMachineSkillEntries } from '../lib/machine-skills.ts';
import { useRegisteredProjects } from '../lib/registered-projects.ts';
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
export function useInstallHost(own: CatalogClient, ownId: string, client: Pick<PluginClient, 'call'>): InstallHost {
  const clientOf = useDaemonClients('catalogs');
  const projects = useRegisteredProjects(client);
  return useMemo(
    () => ({
      createClient: async connection =>
        connection.daemonId === ownId ? own : catalogClientOf(await clientOf(connection.daemonId)),
      projects,
    }),
    [clientOf, own, ownId, projects],
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
    const installHost = useInstallHost(own, id, client);
    const loadMachineSkills = useCallback((signal: AbortSignal) => fetchMachineSkillEntries(client, signal), []);
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
          loadMachineSkills={loadMachineSkills}
        />
      </CatalogClientProvider>
    );
  };
}

/**
 * `/join`, where a share link lands. The link's fragment is NOT read here: the eager module already took it off the
 * address (and out of the history entry) before this chunk was asked for, and holds it in memory. This screen takes
 * the held link on mount; a link that arrives later (a second one opened in the same tab, the router's new entry,
 * `hashchange`) is delivered to it and starts the join over.
 */
export function createJoinScreen(hold: ArrivalHold) {
  return function JoinRoute({ navigate }: DaemonlessScreenProps) {
    const [link, setLink] = useState(() => ({ fragment: hold.waiting(), nonce: 0 }));
    const entryKey = useOptionalRouter()?.entryKey;
    const arrived = useRef(false);
    useEffect(() => {
      const open = (fragment: string): void => setLink(held => ({ fragment, nonce: held.nonce + 1 }));
      const stop = hold.subscribe(open);
      // The link drawn above was only looked at; it is taken now. One that arrived between the draw and this effect
      // differs from it and starts the join over.
      const late = hold.take();
      if (late !== '') setLink(held => (held.fragment === late ? held : { fragment: late, nonce: held.nonce + 1 }));
      return stop;
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `entryKey` is the trigger; a second link navigates to the same path
    useEffect(() => {
      if (!arrived.current) {
        arrived.current = true;
        return;
      }
      hold.read();
    }, [entryKey]);
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
