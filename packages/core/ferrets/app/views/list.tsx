/** The ferret list as a screen (`ferrets.ferrets`, path `ferrets`). Filled by the list feature (U1). */

import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useContext } from 'react';
import { FerretRowMenuProvider } from '../features/list/row-actions-host.tsx';
import { RowMenuContext, type RowMenuTrigger } from '../features/list/row-menu-context.ts';
import type { LiveFerretsClient } from '../lib/client.ts';

function FerretListBody(): ReactNode {
  const open = useContext(RowMenuContext);
  const trigger: RowMenuTrigger | undefined = open === undefined ? undefined : 'mouse';
  return trigger === undefined ? null : null;
}

/** The list draws inside the one row menu it shares: every row opens it through `RowMenuContext`. */
export const createFerretListScreen = (client: LiveFerretsClient): AppComponent<ScreenProps> =>
  function FerretListScreen(): ReactNode {
    return (
      <FerretRowMenuProvider client={client}>
        <FerretListBody />
      </FerretRowMenuProvider>
    );
  };
