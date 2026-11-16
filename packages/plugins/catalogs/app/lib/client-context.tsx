/** The client a Catalogs view rides: the one the shell built this half with, handed down the tree. */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { CatalogClientFactory } from '../features/catalogs/catalogs-api.ts';
import type { CatalogClient } from './catalog-client.ts';

const ClientContext = createContext<CatalogClient | undefined>(undefined);

export function CatalogClientProvider({
  client,
  children,
}: {
  readonly client: CatalogClient;
  readonly children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The daemon-bound client as today's factory: a client belongs to the machine the shell built this half for. */
export function useDaemonClient(): CatalogClientFactory {
  const client = useContext(ClientContext);
  return useMemo(
    () => async () => {
      if (client === undefined) throw new Error('A Catalogs view was drawn outside its client');
      return client;
    },
    [client],
  );
}
