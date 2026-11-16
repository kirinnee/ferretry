/**
 * `skills.row` — Catalogs' part of each skill's row in a ferret's Skills tab: where the skill came from ("from Ines · v2"),
 * the version one of this machine's catalogs holds, and a ⋯ with Publish and Uninstall. Skills draws the row (name, scope,
 * Open) and offers this slot at the end of its first line; the row's catalog logic is `CatalogItemRow` in its `controls`
 * form. Every row of one daemon shares ONE read of the installs and catalogs (`createCatalogRowsStore`), so sixteen skills
 * ask the daemon twice, not thirty-two times.
 */
import { daemonOfClient, daemonTitle, usePairedDaemons } from '@ferretry/app';
import { isSkillsRowSlotProps, type SkillsRowSlotProps } from '@ferretry/plugin-skills/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { CatalogItemRow } from '../features/catalogs/catalog-item-row.tsx';
import { useCatalogRowsStore } from '../features/catalogs/catalog-row-tools.tsx';
import {
  type CatalogRowsStore,
  createCatalogRowsStore,
  readCatalogRows,
} from '../features/catalogs/catalog-rows-store.ts';
import { type CatalogClient, catalogClientOf } from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { daemonConnection } from '../lib/machine.ts';

function SkillsRow({
  own,
  daemon,
  store,
  skill,
}: {
  readonly own: CatalogClient;
  readonly daemon: string;
  readonly store: CatalogRowsStore;
  readonly skill: SkillsRowSlotProps;
}) {
  const read = useCatalogRowsStore(store);
  const paired = usePairedDaemons().find(entry => entry.daemon === daemon);
  const connection = daemonConnection({
    daemonId: daemon,
    daemonName: paired === undefined ? 'This machine' : daemonTitle(paired),
  });
  return (
    <CatalogClientProvider client={own}>
      <CatalogItemRow
        controls
        host={{ connection }}
        read={read}
        kind="skill"
        itemName={skill.name}
        label={skill.invocation}
        source={{ kind: 'skill', skill: skill.path }}
      />
    </CatalogClientProvider>
  );
}

/** One daemon's `skills.row` panel: built once per client, and every row it draws shares the one store. */
export const createSkillsRowPanel = (client: PluginClient): AppComponent<PanelProps> => {
  const own = catalogClientOf(client);
  const store = createCatalogRowsStore(async () => await readCatalogRows(async () => own));
  return function SkillsRowPanel(props: PanelProps) {
    const daemon = daemonOfClient(client);
    return isSkillsRowSlotProps(props) && daemon !== undefined ? (
      <SkillsRow own={own} daemon={daemon} store={store} skill={props} />
    ) : null;
  };
};
