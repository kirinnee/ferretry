/**
 * The Add skills screen and the panel that opens it. The panel is Catalogs' contribution to Skills' `skills.add` slot
 * (the "+ Add skills" button in a ferret's Skills tab); the screen is the page it opens, per daemon.
 */

import { daemonHomeHref, daemonOfClient, daemonTitle, useRouter, useScreenHref, usePairedDaemons } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import { isSkillsAddSlotProps } from '@ferretry/plugin-skills/contract';
import type { PanelProps, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import { ADD_SKILLS_BUTTON } from '../features/add-skills/add-skills-model.ts';
import { AddSkillsPage } from '../features/add-skills/add-skills-page.tsx';
import { placeQuery, readPlace } from '../lib/add-skills-address.ts';
import { type CatalogClient, catalogClientOf } from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { daemonConnection } from '../lib/machine.ts';
import { sharedMembers } from '../lib/members.ts';
import type { SharedController } from '../features/shared/shared-controller.ts';
import { daemonSharingPath } from '../lib/routes.ts';
import { useInstallHost } from './catalogs-views.tsx';

const THIS_DAEMON = 'this';

/** The panel in Skills' header: one button, to the page, carrying where the ferret is. */
export function createAddSkillsPanel(client: PluginClient) {
  return function AddSkillsPanel(props: PanelProps) {
    const { navigate } = useRouter();
    const href = useScreenHref();
    const daemon = daemonOfClient(client);
    if (!isSkillsAddSlotProps(props) || daemon === undefined) return null;
    const target = href(daemon, 'catalogs', 'add-skills', { ferret: props.ferret });
    if (target === undefined) return null;
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => navigate(`${target}${placeQuery(props)}`)}
        data-context-add-skills=""
      >
        {ADD_SKILLS_BUTTON}
      </Button>
    );
  };
}

/** `search` and `members` default to the address bar and this browser's member records; a suite hands its own. */
export function createAddSkillsScreen(
  client: PluginClient,
  search: () => string = () => globalThis.location?.search ?? '',
  members: () => SharedController = sharedMembers,
) {
  const own: CatalogClient = catalogClientOf(client);
  return function AddSkillsScreen({ params }: ScreenProps) {
    const id = daemonOfClient(client) ?? THIS_DAEMON;
    const paired = usePairedDaemons().find(daemon => daemon.daemon === id);
    const machineName = paired === undefined ? 'This machine' : daemonTitle(paired);
    const connection = useMemo(() => daemonConnection({ daemonId: id, daemonName: machineName }), [id, machineName]);
    const installHost = useInstallHost(own, id);
    const href = useScreenHref();
    const { navigate } = useRouter();
    const ferret = params.ferret ?? '';
    const place = useMemo(() => readPlace(search()), []);
    const chat = href(id, 'conversation', 'chat', { ferret });
    return (
      <CatalogClientProvider client={own}>
        <AddSkillsPage
          connection={connection}
          machineName={machineName}
          ferret={ferret}
          place={place}
          members={members()}
          install={installHost}
          onBack={() => navigate(chat ?? daemonHomeHref(id))}
          onSubscribe={() => navigate(daemonSharingPath(connection.daemonId, 'shared'))}
        />
      </CatalogClientProvider>
    );
  };
}
