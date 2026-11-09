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
  useEveryDaemon,
  useNoReach,
  useFragment,
  useHandOff,
  useOwnScreen,
  usePairedDaemons,
  useRouter,
} from '@ferretry/app';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CatalogClient,
  catalogClientOf,
  machineCatalogClient,
  machinePluginClient,
} from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { daemonConnection } from '../lib/machine.ts';
import { sharedMembers } from '../lib/members.ts';
import { fetchMachineSkillEntries } from '../lib/machine-skills.ts';
import { installChooser } from '../lib/choose-install.ts';
import { readRegisteredProjects, useRegisteredProjects } from '../lib/registered-projects.ts';
import { isSharingTab, JOIN_SCREEN_ID, SHARED_PATH } from '../lib/routes.ts';
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

const NO_CLIENTS: ReadonlyMap<string, PluginClient> = new Map();

/**
 * Catalogs' own client on every paired daemon where it runs (`useEveryDaemon`), by daemon id: the same map while no
 * client comes or goes, so a machine's feed or grants answer moving re-reads nothing.
 */
function useCatalogClients(): ReadonlyMap<string, PluginClient> {
  const rows = useEveryDaemon();
  const held = useRef(NO_CLIENTS);
  const next = new Map(rows.map(row => [row.daemon, row.client]));
  const same =
    next.size === held.current.size && [...next].every(([daemon, client]) => held.current.get(daemon) === client);
  if (!same) held.current = next.size === 0 ? NO_CLIENTS : next;
  return held.current;
}

/** Installs go through THAT machine's own client: this one's, or Catalogs' own row on another paired daemon. */
export function useInstallHost(own: CatalogClient, ownId: string, client: Pick<PluginClient, 'call'>): InstallHost {
  const others = useCatalogClients();
  const whyNone = useNoReach();
  const live = useRef(others);
  live.current = others;
  // The projects an install offers are the TARGET machine's, read through that machine's own client.
  const projects = useRegisteredProjects(client);
  return useMemo(() => {
    const source = { clients: () => live.current, whyNone };
    const projectClient = machinePluginClient(client, ownId, source);
    return {
      createClient: machineCatalogClient(own, ownId, source),
      projects,
      readProjects: async connection => readRegisteredProjects(await projectClient(connection)),
    };
  }, [own, ownId, whyNone, client, projects]);
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

/** What `/join` draws while a link arrived and its code is not taken yet: never the code itself. */
export const OPENING_LINK = 'Opening link…';

/**
 * `/join`, where a share link lands. The link's fragment is NOT read from the address: the shell took it off the address
 * bar and the history entry before this chunk was asked for (shell contract S3) and holds it in memory; this screen
 * takes it once, in an effect. A link that arrives later (a second one opened in the same tab, the router's new entry,
 * `hashchange`) bumps the arrival and starts the join over. 'Subscribe with a link' carries its code here in memory
 * (`handOff`), never through the address.
 */
export function createJoinScreen() {
  return function JoinRoute({ navigate }: DaemonlessScreenProps) {
    const { arrival, take } = useFragment(JOIN_SCREEN_ID);
    const handed = useHandOff(useOwnScreen<string>(JOIN_SCREEN_ID));
    const [link, setLink] = useState<{ readonly fragment: string; readonly nonce: number } | null>(() =>
      handed === undefined ? null : { fragment: handed, nonce: 0 },
    );
    useEffect(() => {
      if (arrival === 0) return;
      const taken = take();
      // Nothing to take (it expired, or this effect ran again): keep what is open, or open the no-link page.
      if (taken === undefined) setLink(held => held ?? { fragment: '', nonce: 0 });
      else setLink(held => ({ fragment: taken, nonce: (held?.nonce ?? 0) + 1 }));
    }, [arrival, take]);
    const now = useCallback(() => new Date(), []);
    if (link === null && arrival > 0)
      return (
        <p role="status" className="m-0 p-4 text-cell text-muted" data-join-opening="">
          {OPENING_LINK}
        </p>
      );
    return (
      <JoinScreen
        key={link?.nonce ?? 0}
        members={sharedMembers()}
        fragment={link?.fragment ?? ''}
        now={now}
        onShared={() => navigate(SHARED_PATH)}
        onHome={() => navigate(HOME_HREF)}
      />
    );
  };
}

/**
 * `/shared`, what is shared with this browser across publishers. It has no client, so no machine is listed: Install
 * ASKS (`chooseDaemon`), and only the machine the person picks gives this half a client, its own on that machine. The
 * choice spends no share code: the item was already opened and verified through the member transport.
 */
export function createSharedScreen() {
  return function SharedRoute({ navigate, chooseDaemon }: DaemonlessScreenProps) {
    const chooseInstall = useMemo(() => installChooser(chooseDaemon), [chooseDaemon]);
    return (
      <SharedWithMe
        members={sharedMembers()}
        machines={[]}
        chooseInstall={chooseInstall}
        onHome={() => navigate(HOME_HREF)}
      />
    );
  };
}
