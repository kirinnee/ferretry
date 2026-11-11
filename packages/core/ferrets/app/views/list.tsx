/**
 * The ferret list as a screen (`ferrets`, path `ferrets` = `/d/<daemon>/ferrets`). On a wide screen Layouts puts it in
 * the side column; on a phone it is the first bottom-nav item. The daemon and the open ferret come from the route.
 */

import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import '../features/list/ferret-list.css';
import { FerretList } from '../features/list/ferret-list.tsx';
import type { LiveFerretsClient } from '../lib/client.ts';

export const createFerretListScreen = (client: LiveFerretsClient): AppComponent<ScreenProps> =>
  function FerretListScreen(): ReactNode {
    return <FerretList client={client} />;
  };
