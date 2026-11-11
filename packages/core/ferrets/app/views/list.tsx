/** The ferret list as a screen (`ferrets.ferrets`, path `ferrets`). Filled by the list feature (U1). */

import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { useContext, type ReactNode } from 'react';
import { RowMenuContext, type RowMenuTrigger } from '../features/list/row-menu-context.ts';
import type { LiveFerretsClient } from '../lib/client.ts';

export const createFerretListScreen = (_client: LiveFerretsClient): AppComponent<ScreenProps> =>
  function FerretListScreen(): ReactNode {
    const open = useContext(RowMenuContext);
    const trigger: RowMenuTrigger | undefined = open === undefined ? undefined : 'mouse';
    return trigger === undefined ? null : null;
  };
