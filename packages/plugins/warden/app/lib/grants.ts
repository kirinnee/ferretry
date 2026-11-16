/**
 * What this device may do with the Warden, read from Gate's grants (`GET /v1/grants`, a core route every caller may
 * read, because a restricted screen has to say why it is restricted). The answer is parsed with Gate's own
 * `GrantsViewSchema`; only the `use` axis is kept: whether `warden.use` is open and, when it is not, why.
 */

import { type CapabilityGrantView, GrantsViewSchema } from '@ferretry/core-gate/contract';
import { GRANTS_ROUTE } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';

export interface GrantsView {
  readonly capabilities: readonly Pick<CapabilityGrantView, 'capability' | 'use' | 'useRefusal'>[];
}

/** The grants as the Warden reads them, through the client of the daemon in question. */
export const readGrants = async (client: Pick<PluginClient, 'call'>): Promise<GrantsView> => {
  const view = GrantsViewSchema.parse(await client.call<unknown>(GRANTS_ROUTE));
  return {
    capabilities: view.capabilities.map(row => ({
      capability: row.capability,
      use: row.use,
      useRefusal: row.useRefusal,
    })),
  };
};
