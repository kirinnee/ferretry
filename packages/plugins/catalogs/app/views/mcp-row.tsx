/**
 * Catalogs' part of a ferret's MCP tab, into the two slots MCP offers (`@ferretry/plugin-mcp/contract`):
 * - `mcp.row` — "from Ines · v2" and a ⋯ with Publish / Uninstall on each server's row, the `controls` form of
 *   `CatalogItemRow`. Every row of one daemon shares ONE read of the installs and catalogs (`createCatalogRowsStore`).
 * - `mcp.install` — "More ▾ › Install from a file…" in the header, the offline way in to a catalog file.
 */
import { daemonOfClient, daemonTitle, usePairedDaemons } from '@ferretry/app';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { isMcpInstallSlotProps, isMcpRowSlotProps, type McpRowSlotProps } from '@ferretry/plugin-mcp/contract';
import { useMemo, useState } from 'react';
import { CatalogItemRow } from '../features/catalogs/catalog-item-row.tsx';
import { CatalogMoreMenu } from '../features/catalogs/catalog-more-menu.tsx';
import { useCatalogRowsStore } from '../features/catalogs/catalog-row-tools.tsx';
import {
  type CatalogRowsStore,
  createCatalogRowsStore,
  readCatalogRows,
} from '../features/catalogs/catalog-rows-store.ts';
import { InstallFromFileSheet } from '../features/catalogs/install-from-file-sheet.tsx';
import { type CatalogClient, catalogClientOf } from '../lib/catalog-client.ts';
import { CatalogClientProvider } from '../lib/client-context.tsx';
import { daemonConnection } from '../lib/machine.ts';

/** This daemon's connection, named by the paired list when this browser is paired with it. */
function useConnection(daemon: string) {
  const paired = usePairedDaemons().find(entry => entry.daemon === daemon);
  const daemonName = paired === undefined ? 'This machine' : daemonTitle(paired);
  return useMemo(() => daemonConnection({ daemonId: daemon, daemonName }), [daemon, daemonName]);
}

function McpRow({
  own,
  daemon,
  store,
  server,
}: {
  readonly own: CatalogClient;
  readonly daemon: string;
  readonly store: CatalogRowsStore;
  readonly server: McpRowSlotProps;
}) {
  const read = useCatalogRowsStore(store);
  const connection = useConnection(daemon);
  return (
    <CatalogClientProvider client={own}>
      <CatalogItemRow
        controls
        host={{ connection }}
        read={read}
        kind="mcp"
        itemName={server.name}
        label={server.name}
        source={{ kind: 'mcp', mcp: server.id }}
      />
    </CatalogClientProvider>
  );
}

/** One daemon's `mcp.row` panel: built once per client, and every row it draws shares the one store. */
export const createMcpRowPanel = (client: PluginClient): AppComponent<PanelProps> => {
  const own = catalogClientOf(client);
  const store = createCatalogRowsStore(async () => await readCatalogRows(async () => own));
  return function McpRowPanel(props: PanelProps) {
    const daemon = daemonOfClient(client);
    return isMcpRowSlotProps(props) && daemon !== undefined ? (
      <McpRow own={own} daemon={daemon} store={store} server={props} />
    ) : null;
  };
};

function McpInstall({ own, daemon }: { readonly own: CatalogClient; readonly daemon: string }) {
  const [open, setOpen] = useState(false);
  const connection = useConnection(daemon);
  return (
    <CatalogClientProvider client={own}>
      <span data-catalog-mcp-install="">
        <CatalogMoreMenu onInstallFromFile={() => setOpen(true)} />
      </span>
      {open ? <InstallFromFileSheet connection={connection} onClose={() => setOpen(false)} /> : null}
    </CatalogClientProvider>
  );
}

/** One daemon's `mcp.install` panel: the header's way in to a catalog file. */
export const createMcpInstallPanel = (client: PluginClient): AppComponent<PanelProps> => {
  const own = catalogClientOf(client);
  return function McpInstallPanel(props: PanelProps) {
    const daemon = daemonOfClient(client);
    return isMcpInstallSlotProps(props) && daemon !== undefined ? <McpInstall own={own} daemon={daemon} /> : null;
  };
};
