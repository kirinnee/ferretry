/**
 * What this device may do with the Warden, read from Gate's grants (`GET /v1/grants`, a core route every caller may
 * read, because a restricted screen has to say why it is restricted). Only the `use` axis is read: whether
 * `warden.use` is open and, when it is not, why. Not strict — Gate owns the rest of the view.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { GRANTS_ROUTE } from '@ferretry/app/ui';
import { z } from 'zod';

export interface GrantsView {
  readonly capabilities: readonly {
    readonly capability: string;
    readonly use: boolean;
    readonly useRefusal?: string;
  }[];
}

const GrantsViewSchema = z.object({
  capabilities: z.array(z.object({ capability: z.string(), use: z.boolean(), useRefusal: z.string().optional() })),
});

/** The grants as the Warden reads them, through the client of the daemon in question. */
export const readGrants = async (client: Pick<PluginClient, 'call'>): Promise<GrantsView> => {
  const view = GrantsViewSchema.parse(await client.call<unknown>(GRANTS_ROUTE));
  return {
    capabilities: view.capabilities.map(row => ({
      capability: row.capability,
      use: row.use,
      ...(row.useRefusal === undefined ? {} : { useRefusal: row.useRefusal }),
    })),
  };
};
