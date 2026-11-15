/**
 * `ferrets.actions-row` — Catalogs' row in a ferret's Actions ▾ menu, "Add skills…": the same way in to the skills of the
 * catalogs this device subscribes to as the "+ Add skills" button in the ferret's Skills tab. The menu is Ferrets'; this row
 * reaches it through the slot and goes to the Add skills page from `run`. Offered only to a caller who may control the ferret.
 */
import { daemonOfClient, useRouter, useScreenHref } from '@ferretry/app';
import { type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useRef } from 'react';
import { placeQueryOfFerret } from '../lib/add-skills-address.ts';

const ADD_SKILLS_ACTION_ID = 'add-skills';
const ADD_SKILLS_ROW_LABEL = 'Add skills…';

function AddSkillsRow({
  client,
  ferret,
  canControl,
  offer,
}: {
  readonly client: PluginClient;
  readonly ferret: string;
  readonly canControl: boolean;
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
}) {
  const { navigate } = useRouter();
  const href = useScreenHref();
  const daemon = daemonOfClient(client);
  // The shell hands a fresh href function every render; the row reads the latest at run time and is offered once.
  const latest = useRef({ navigate, href });
  latest.current = { navigate, href };
  const addressed = daemon !== undefined && href(daemon, 'catalogs', 'add-skills', { ferret }) !== undefined;
  useEffect(() => {
    if (!canControl || daemon === undefined || !addressed) {
      offer(ADD_SKILLS_ACTION_ID, null);
      return;
    }
    offer(ADD_SKILLS_ACTION_ID, {
      kind: 'run',
      id: ADD_SKILLS_ACTION_ID,
      label: ADD_SKILLS_ROW_LABEL,
      group: 'ferret',
      order: 20,
      run: async () => {
        const target = latest.current.href(daemon, 'catalogs', 'add-skills', { ferret });
        if (target === undefined) return;
        latest.current.navigate(`${target}${await placeQueryOfFerret(client, ferret)}`);
      },
    });
    return () => offer(ADD_SKILLS_ACTION_ID, null);
  }, [addressed, canControl, client, daemon, ferret, offer]);
  return null;
}

export const createAddSkillsRowPanel = (client: PluginClient): AppComponent<PanelProps> =>
  function AddSkillsRowPanel(props: PanelProps) {
    return isActionsRowSlotProps(props) ? (
      <AddSkillsRow canControl={props.canControl} client={client} ferret={props.ferret} offer={props.offer} />
    ) : null;
  };
